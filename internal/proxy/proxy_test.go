package proxy_test

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yuanying/penelope/internal/certs"
	"github.com/yuanying/penelope/internal/config"
	"github.com/yuanying/penelope/internal/credentials"
	"github.com/yuanying/penelope/internal/proxy"
	"github.com/yuanying/penelope/internal/record"
	"github.com/yuanying/penelope/internal/testca"
)

const (
	surrogate      = "surrogate-example-0001"
	otherSurrogate = "surrogate-example-0002"
	realKey        = "real-key-0001"
)

type recorder struct {
	mu   sync.Mutex
	recs []*record.Record
}

func (r *recorder) Write(rec *record.Record) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c := *rec
	r.recs = append(r.recs, &c)
}

// wait returns the records once there are n.
func (r *recorder) wait(t *testing.T, n int) []*record.Record {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		if len(r.recs) >= n {
			defer r.mu.Unlock()
			return append([]*record.Record(nil), r.recs...)
		}
		r.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	t.Fatalf("%d records, want %d: %+v", len(r.recs), n, r.recs)
	return nil
}

type owners struct{}

func (owners) UID(string, netip.AddrPort) (int, bool) { return 1000, true }

// world is a Sentinel under test with the upstreams it reaches.
type world struct {
	t        *testing.T
	ca       *testca.CA // the Sentinel's
	upCA     *testca.CA // the upstreams'
	upMinter *certs.Minter
	rec      *recorder
	addr     string // the Sentinel's listener
	keyFile  string

	mu     sync.Mutex
	dst    netip.AddrPort
	routes map[string]string // dst (or unix path) -> where it really is
}

func newWorld(t *testing.T) *world {
	t.Helper()
	w := &world{t: t, ca: testca.New(t), upCA: testca.New(t), rec: &recorder{}, routes: map[string]string{}}
	m, err := certs.Load(w.upCA.CertFile, w.upCA.KeyFile)
	if err != nil {
		t.Fatal(err)
	}
	w.upMinter = m
	w.keyFile = filepath.Join(t.TempDir(), "key")
	if err := os.WriteFile(w.keyFile, []byte(realKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return w
}

// start starts the Sentinel with the configuration's default and hosts.
// %UPCA% and %KEY% stand for the upstreams' CA and the key's file.
func (w *world) start(rest string, opts ...func(*proxy.Config)) {
	w.t.Helper()
	rest = strings.ReplaceAll(rest, "%UPCA%", w.upCA.CertFile)
	rest = strings.ReplaceAll(rest, "%KEY%", w.keyFile)
	cfg, err := config.Parse([]byte("listen: {proxy: [\"127.0.0.1:15001\"], dns: [\"127.0.0.1:15053\"]}\nca: {cert: a, key: b}\n" + rest))
	if err != nil {
		w.t.Fatalf("config: %v", err)
	}
	minter, err := certs.Load(w.ca.CertFile, w.ca.KeyFile)
	if err != nil {
		w.t.Fatal(err)
	}
	pc := proxy.Config{
		Policy: func() *config.Config { return cfg },
		Minter: minter,
		Keys:   credentials.Files{},
		Log:    w.rec,
		Owners: owners{},
		OriginalDst: func(net.Conn) (netip.AddrPort, error) {
			w.mu.Lock()
			defer w.mu.Unlock()
			return w.dst, nil
		},
		Dial: func(ctx context.Context, network, addr string) (net.Conn, error) {
			w.mu.Lock()
			real, ok := w.routes[addr]
			w.mu.Unlock()
			if !ok {
				return nil, fmt.Errorf("nothing at %s", addr)
			}
			if network == "unix" {
				return (&net.Dialer{}).DialContext(ctx, "unix", real)
			}
			return (&net.Dialer{}).DialContext(ctx, "tcp", real)
		},
		PeekTimeout: 200 * time.Millisecond,
	}
	for _, o := range opts {
		o(&pc)
	}
	p := proxy.New(pc)
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		w.t.Fatal(err)
	}
	go func() { _ = p.Serve(ln) }()
	w.t.Cleanup(func() { _ = p.Close() })
	w.addr = ln.Addr().String()
}

// to makes the next connections go to dst, as the sandbox meant.
func (w *world) to(dst string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.dst = netip.MustParseAddrPort(dst)
}

func (w *world) route(from, to string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.routes[from] = to
}

// tlsUpstream serves h over TLS for name, with a certificate of the
// upstreams' CA, and returns where.
func (w *world) tlsUpstream(name string, h http.Handler) string {
	w.t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		w.t.Fatal(err)
	}
	srv := &http.Server{Handler: h, TLSConfig: &tls.Config{
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return w.upMinter.Certificate(name) },
	}}
	go func() { _ = srv.ServeTLS(ln, "", "") }()
	w.t.Cleanup(func() { _ = srv.Close() })
	return ln.Addr().String()
}

func (w *world) plainUpstream(network string, h http.Handler) string {
	w.t.Helper()
	addr := "127.0.0.1:0"
	if network == "unix" {
		addr = filepath.Join(w.t.TempDir(), "up.sock")
	}
	ln, err := net.Listen(network, addr)
	if err != nil {
		w.t.Fatal(err)
	}
	srv := &http.Server{Handler: h}
	go func() { _ = srv.Serve(ln) }()
	w.t.Cleanup(func() { _ = srv.Close() })
	return ln.Addr().String()
}

// client is an HTTP client whose every connection goes to the Sentinel,
// trusting roots.
func (w *world) client(roots *testca.CA) *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp", w.addr)
		},
		TLSClientConfig: &tls.Config{RootCAs: roots.Pool()},
	}}
}

func get(t *testing.T, c *http.Client, url string, header http.Header) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, vs := range header {
		req.Header[k] = vs
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func TestTLSToAHostThatIsNotRegisteredIsPassedThrough(t *testing.T) {
	w := newWorld(t)
	up := w.tlsUpstream("other.example.com", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(rw, "from upstream")
	}))
	w.start("")
	w.to("203.0.113.10:443")
	w.route("203.0.113.10:443", up)

	// The client trusts the upstreams' CA only: the certificate it sees
	// is the upstream's own.
	c := w.client(w.upCA)
	resp, body := get(t, c, "https://other.example.com/x", http.Header{"Authorization": {"Bearer " + surrogate}})
	if resp.StatusCode != 200 || body != "from upstream" {
		t.Fatalf("got %d %q", resp.StatusCode, body)
	}
	// A passthrough is recorded when it ends.
	c.CloseIdleConnections()
	r := w.rec.wait(t, 1)[0]
	if r.Kind != record.KindTCP || r.Action != record.Passthrough || r.Host != "other.example.com" ||
		r.Addr != "203.0.113.10" || r.Port != 443 || r.BytesIn == 0 || r.BytesOut == 0 {
		t.Errorf("record = %+v", r)
	}
	if r.UID == nil || *r.UID != 1000 {
		t.Errorf("UID = %v, want 1000", r.UID)
	}
}

func TestARegisteredHostSwapsASharedSurrogateInItsOwnPlace(t *testing.T) {
	w := newWorld(t)
	up := w.tlsUpstream("api.example.com", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if user, password, ok := r.BasicAuth(); !ok || user != "x-access-token" || password != realKey {
			http.Error(rw, "unexpected Basic credentials", http.StatusUnauthorized)
			return
		}
		rw.Header().Set(proxy.MarkHeader, "deny")
		_, _ = io.WriteString(rw, "hello "+r.Host+" "+r.URL.RequestURI())
	}))
	w.start(`
hosts:
  - name: auth.example.com
    credentials:
      - place: bearer
        surrogate: ` + surrogate + `
        source: { file: %KEY% }
  - name: api.example.com
    upstream_ca: %UPCA%
    credentials:
      - place: basic
        surrogate: ` + surrogate + `
        source: { file: %KEY% }
`)
	w.to("203.0.113.11:443")
	w.route("api.example.com:443", up)

	// The client trusts the Sentinel's CA: the host is opened.
	basic := "Basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+surrogate))
	resp, body := get(t, w.client(w.ca), "https://api.example.com/v1/x?a=b", http.Header{"Authorization": {basic}})
	if resp.StatusCode != 200 || body != "hello api.example.com /v1/x?a=b" {
		t.Fatalf("got %d %q", resp.StatusCode, body)
	}
	if resp.Header.Get(proxy.MarkHeader) != "" {
		t.Error("the upstream's mark header reached the sandbox")
	}
	r := w.rec.wait(t, 1)[0]
	if r.Kind != record.KindHTTP || r.Action != record.Open || r.Host != "api.example.com" || r.Method != "GET" ||
		r.Path != "/v1/x" || r.Status != 200 || r.Addr != "203.0.113.11" || r.Port != 443 || r.BytesIn == 0 {
		t.Errorf("record = %+v", r)
	}
	// Neither the key nor its surrogate, nor the query, reaches the record (ADR-0004, docs/sentinel-config.md).
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{realKey, surrogate, "a=b"} {
		if strings.Contains(string(b), s) {
			t.Errorf("the record holds %q: %s", s, b)
		}
	}
}

func TestOpenedRequestsThatCannotBeSentAreRefused(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	up := w.tlsUpstream("api.example.com", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	missing := filepath.Join(t.TempDir(), "missing")
	w.start(`
hosts:
  - name: api.example.com
    upstream_ca: %UPCA%
    credentials:
      - place: bearer
        surrogate: ` + surrogate + `
        source: { file: %KEY% }
  - name: auth.example.com
    credentials:
      - place: basic
        surrogate: ` + surrogate + `
        source: { file: %KEY% }
  - name: nokey.example.com
    upstream_ca: %UPCA%
    credentials:
      - place: bearer
        surrogate: ` + otherSurrogate + `
        source: { file: ` + missing + ` }
`)
	w.to("203.0.113.11:443")
	w.route("api.example.com:443", up)
	w.route("nokey.example.com:443", up)
	c := w.client(w.ca)

	tests := []struct {
		name   string
		url    string
		header http.Header
		status int
		reason string
	}{
		{"a surrogate out of its place", "https://api.example.com/?t=" + surrogate, nil, 403, string(credentials.ReasonSurrogate)},
		{"a shared surrogate on a host without its registration", "https://nokey.example.com/", http.Header{"Authorization": {"Bearer " + surrogate}}, 403, string(credentials.ReasonSurrogate)},
		{"a key that cannot be read", "https://nokey.example.com/", http.Header{"Authorization": {"Bearer " + otherSurrogate}}, 503, string(credentials.ReasonKey)},
		{"a Host that is not the SNI", "https://api.example.com/", http.Header{"Host": {"evil.example.com"}}, 403, "host-mismatch"},
	}
	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, _ := http.NewRequest(http.MethodGet, tt.url, nil)
			for k, vs := range tt.header {
				req.Header[k] = vs
			}
			if h := tt.header.Get("Host"); h != "" {
				req.Host = h
			}
			resp, err := c.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode != tt.status || resp.Header.Get(proxy.MarkHeader) == "" {
				t.Errorf("got %d (mark %q) %q, want %d with the mark", resp.StatusCode, resp.Header.Get(proxy.MarkHeader), body, tt.status)
			}
			r := w.rec.wait(t, i+1)[i]
			if r.Action != record.Deny || r.Reason != tt.reason || r.Kind != record.KindHTTP {
				t.Errorf("record = %+v, want deny for %s", r, tt.reason)
			}
			if strings.Contains(r.Path, surrogate) {
				t.Errorf("the record's path holds the surrogate: %q", r.Path)
			}
		})
	}
	if n := hits.Load(); n != 0 {
		t.Errorf("the upstream was asked %d times", n)
	}
}

func TestPlainHTTPIsReadPassedThroughAndItsSurrogatesRefused(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	up := w.plainUpstream("tcp4", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = io.WriteString(rw, "plain "+r.Host)
	}))
	w.start(`
hosts:
  - name: api.example.com
    credentials:
      - place: bearer
        surrogate: ` + surrogate + `
        source: { file: %KEY% }
`)
	w.to("203.0.113.20:80")
	w.route("203.0.113.20:80", up)
	c := w.client(w.ca)

	resp, body := get(t, c, "http://site.example.com/p", nil)
	if resp.StatusCode != 200 || body != "plain site.example.com" {
		t.Fatalf("got %d %q", resp.StatusCode, body)
	}
	r := w.rec.wait(t, 1)[0]
	if r.Kind != record.KindHTTP || r.Action != record.Passthrough || r.Host != "site.example.com" || r.Path != "/p" || r.Status != 200 {
		t.Errorf("record = %+v", r)
	}

	resp, _ = get(t, c, "http://site.example.com/q", http.Header{"Authorization": {"Bearer " + surrogate}})
	if resp.StatusCode != 403 || resp.Header.Get(proxy.MarkHeader) != "deny" {
		t.Errorf("a surrogate in plain HTTP got %d", resp.StatusCode)
	}
	r = w.rec.wait(t, 2)[1]
	if r.Action != record.Deny || r.Reason != string(credentials.ReasonSurrogate) {
		t.Errorf("record = %+v", r)
	}
	if n := hits.Load(); n != 1 {
		t.Errorf("the upstream was asked %d times, want 1", n)
	}
}

func TestUpstreamsOverHTTPAndAUnixSocket(t *testing.T) {
	for _, network := range []string{"tcp4", "unix"} {
		t.Run(network, func(t *testing.T) {
			w := newWorld(t)
			up := w.plainUpstream(network, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(rw, r.Host+" "+r.Header.Get("Authorization"))
			}))
			upstream := "http://backend.internal.example.com:8080"
			from := "backend.internal.example.com:8080"
			if network == "unix" {
				upstream, from = "unix://"+up, up
			}
			w.start(`
hosts:
  - name: backend.example.com
    upstream: ` + upstream + `
    credentials:
      - place: bearer
        surrogate: ` + surrogate + `
        source: { file: %KEY% }
`)
			w.to("203.0.113.30:443")
			w.route(from, up)
			resp, body := get(t, w.client(w.ca), "https://backend.example.com/v1/events", http.Header{"Authorization": {"Bearer " + surrogate}})
			if resp.StatusCode != 200 || body != "backend.example.com Bearer "+realKey {
				t.Fatalf("got %d %q", resp.StatusCode, body)
			}
		})
	}
}

func TestAnUpgradeIsRelayedBothWays(t *testing.T) {
	w := newWorld(t)
	up := w.tlsUpstream("api.example.com", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "echo" || r.Header.Get("Authorization") != "Bearer "+realKey {
			http.Error(rw, "no", 400)
			return
		}
		c, brw, err := http.NewResponseController(rw).Hijack()
		if err != nil {
			return
		}
		defer func() { _ = c.Close() }()
		_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n")
		_ = brw.Flush()
		line, _ := brw.ReadString('\n')
		_, _ = brw.WriteString("echo: " + line)
		_ = brw.Flush()
	}))
	w.start(`
hosts:
  - name: api.example.com
    upstream_ca: %UPCA%
    credentials:
      - place: bearer
        surrogate: ` + surrogate + `
        source: { file: %KEY% }
`)
	w.to("203.0.113.11:443")
	w.route("api.example.com:443", up)

	raw, err := net.Dial("tcp4", w.addr)
	if err != nil {
		t.Fatal(err)
	}
	c := tls.Client(raw, &tls.Config{ServerName: "api.example.com", RootCAs: w.ca.Pool()})
	defer func() { _ = c.Close() }()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	_, _ = io.WriteString(c, "GET /stream HTTP/1.1\r\nHost: api.example.com\r\nConnection: Upgrade\r\nUpgrade: echo\r\nAuthorization: Bearer "+surrogate+"\r\n\r\n")
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 101 {
		t.Fatalf("status %d, want 101", resp.StatusCode)
	}
	_, _ = io.WriteString(c, "ping\n")
	line, err := br.ReadString('\n')
	if err != nil || line != "echo: ping\n" {
		t.Errorf("read %q, %v", line, err)
	}
	_ = c.Close()
	r := w.rec.wait(t, 1)[0]
	if r.Status != 101 || r.Action != record.Open {
		t.Errorf("record = %+v", r)
	}
}

func TestAResponseIsHandedOnAsItArrives(t *testing.T) {
	w := newWorld(t)
	release := make(chan struct{})
	up := w.tlsUpstream("api.example.com", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(rw, "first\n")
		_ = http.NewResponseController(rw).Flush()
		<-release
		_, _ = io.WriteString(rw, "second\n")
	}))
	w.start("hosts:\n  - name: api.example.com\n    upstream_ca: %UPCA%\n")
	w.to("203.0.113.11:443")
	w.route("api.example.com:443", up)

	resp, err := w.client(w.ca).Get("https://api.example.com/watch")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	br := bufio.NewReader(resp.Body)
	done := make(chan string)
	go func() {
		line, _ := br.ReadString('\n')
		done <- line
	}()
	select {
	case line := <-done:
		if line != "first\n" {
			t.Errorf("first line %q", line)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the first part did not arrive before the response ended")
	}
	close(release)
}

func TestAConnectionThatSaysNothingFirstIsPassedThrough(t *testing.T) {
	w := newWorld(t)
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = c.Close() }()
		_, _ = io.WriteString(c, "220 banner\r\n")
		line, _ := bufio.NewReader(c).ReadString('\n')
		_, _ = io.WriteString(c, "got "+line)
	}()
	w.start("")
	w.to("203.0.113.40:25")
	w.route("203.0.113.40:25", ln.Addr().String())

	c, err := net.Dial("tcp4", w.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	br := bufio.NewReader(c)
	if line, err := br.ReadString('\n'); err != nil || line != "220 banner\r\n" {
		t.Fatalf("banner %q, %v", line, err)
	}
	_, _ = io.WriteString(c, "EHLO x\r\n")
	if line, err := br.ReadString('\n'); err != nil || line != "got EHLO x\r\n" {
		t.Errorf("reply %q, %v", line, err)
	}
}

func TestBytesThatAreNeitherTLSNorHTTPArePassedThrough(t *testing.T) {
	w := newWorld(t)
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = c.Close() }()
		line, _ := bufio.NewReader(c).ReadString('\n')
		_, _ = io.WriteString(c, "server saw "+line)
	}()
	w.start("")
	w.to("203.0.113.41:22")
	w.route("203.0.113.41:22", ln.Addr().String())
	c, err := net.Dial("tcp4", w.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	_, _ = io.WriteString(c, "SSH-2.0-test\r\n")
	if line, err := bufio.NewReader(c).ReadString('\n'); err != nil || line != "server saw SSH-2.0-test\r\n" {
		t.Errorf("read %q, %v", line, err)
	}
}

func TestConnectionsTheSentinelRefuses(t *testing.T) {
	tests := map[string]struct {
		dst    string
		direct bool
		rest   string
		reason string
	}{
		"to a link-local IPv4 address":            {dst: "169.254.169.254:80", reason: "link-local"},
		"to a link-local IPv6 address":            {dst: "[fe80::1]:80", reason: "link-local"},
		"to link-local IPv4 in IPv6":              {dst: "[::ffff:169.254.169.254]:80", reason: "link-local"},
		"to link-local IPv4 in NAT64":             {dst: "[64:ff9b::a9fe:a9fe]:80", reason: "link-local"},
		"straight to the listener":                {direct: true, reason: "direct"},
		"to a host not registered, default deny":  {dst: "203.0.113.50:443", rest: "default: deny\n", reason: "not-registered"},
		"plain HTTP not registered, default deny": {dst: "203.0.113.50:80", rest: "default: deny\n", reason: "not-registered"},
	}
	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t)
			w.start(tt.rest)
			if tt.direct {
				w.to(w.addr)
			} else {
				w.to(tt.dst)
			}
			w.route(tt.dst, "127.0.0.1:1")
			c, err := net.Dial("tcp4", w.addr)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = c.Close() }()
			_ = c.SetDeadline(time.Now().Add(5 * time.Second))
			if strings.HasSuffix(tt.dst, ":443") {
				tc := tls.Client(c, &tls.Config{ServerName: "x.example.com", RootCAs: w.ca.Pool()})
				if err := tc.Handshake(); err == nil {
					t.Error("the handshake went through")
				}
			} else {
				_, _ = io.WriteString(c, "GET / HTTP/1.1\r\nHost: x.example.com\r\n\r\n")
				b, _ := io.ReadAll(c)
				if len(b) > 0 && !strings.Contains(string(b), " 403 ") {
					t.Errorf("got %q", b)
				}
			}
			r := w.rec.wait(t, 1)[0]
			if r.Action != record.Deny || r.Reason != tt.reason {
				t.Errorf("record = %+v, want deny for %s", r, tt.reason)
			}
		})
	}
}

func TestAConnectionWhoseDestinationIsNotKnownIsRefused(t *testing.T) {
	w := newWorld(t)
	w.start("", func(c *proxy.Config) {
		c.OriginalDst = func(net.Conn) (netip.AddrPort, error) { return netip.AddrPort{}, errors.New("ENOENT") }
	})
	c, err := net.Dial("tcp4", w.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	r := w.rec.wait(t, 1)[0]
	if r.Action != record.Deny || r.Reason != "direct" {
		t.Errorf("record = %+v", r)
	}
}

func TestANewConfigurationAppliesToNewConnections(t *testing.T) {
	w := newWorld(t)
	up := w.tlsUpstream("api.example.com", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(rw, "ok")
	}))
	parse := func(rest string) *config.Config {
		c, err := config.Parse([]byte("listen: {proxy: [\"127.0.0.1:15001\"], dns: [\"127.0.0.1:15053\"]}\nca: {cert: a, key: b}\n" + strings.ReplaceAll(rest, "%UPCA%", w.upCA.CertFile)))
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	var mu sync.Mutex
	cur := parse("")
	w.start("", func(c *proxy.Config) {
		c.Policy = func() *config.Config { mu.Lock(); defer mu.Unlock(); return cur }
	})
	w.to("203.0.113.11:443")
	w.route("203.0.113.11:443", up)
	w.route("api.example.com:443", up)

	// Passed through: the client must trust the upstream.
	pass := w.client(w.upCA)
	if resp, _ := get(t, pass, "https://api.example.com/", nil); resp.StatusCode != 200 {
		t.Fatalf("passthrough got %d", resp.StatusCode)
	}
	// A passthrough is recorded when it ends.
	pass.CloseIdleConnections()
	w.rec.wait(t, 1)
	mu.Lock()
	cur = parse("hosts:\n  - name: api.example.com\n    upstream_ca: %UPCA%\n")
	mu.Unlock()
	// Opened: the client must trust the Sentinel.
	if resp, _ := get(t, w.client(w.ca), "https://api.example.com/", nil); resp.StatusCode != 200 {
		t.Fatalf("opened got %d", resp.StatusCode)
	}
	recs := w.rec.wait(t, 2)
	if recs[0].Action != record.Passthrough || recs[1].Action != record.Open {
		t.Errorf("actions %s then %s, want passthrough then open", recs[0].Action, recs[1].Action)
	}
}

// A wildcard registration opens every name of one label under it: each
// name gets a certificate of its own, is sent to itself upstream with the
// surrogate swapped, and is recorded by its own name (ADR-0025).
func TestAWildcardRegistrationOpensEachNameUnderIt(t *testing.T) {
	w := newWorld(t)
	handler := func(name string) http.Handler {
		return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
			if got := r.Header.Get("Authorization"); got != "Bearer "+realKey {
				http.Error(rw, "Authorization = "+got, http.StatusUnauthorized)
				return
			}
			_, _ = io.WriteString(rw, name+" "+r.Host)
		})
	}
	w.start(`
hosts:
  - name: "*.apps.example.com"
    upstream_ca: %UPCA%
    credentials:
      - place: bearer
        surrogate: ` + surrogate + `
        source: { file: %KEY% }
`)
	w.to("203.0.113.12:443")
	w.route("a.apps.example.com:443", w.tlsUpstream("a.apps.example.com", handler("upstream-a")))
	w.route("b.apps.example.com:443", w.tlsUpstream("b.apps.example.com", handler("upstream-b")))
	c := w.client(w.ca)

	for i, name := range []string{"a", "b"} {
		host := name + ".apps.example.com"
		resp, body := get(t, c, "https://"+host+"/x", http.Header{"Authorization": {"Bearer " + surrogate}})
		if resp.StatusCode != 200 || body != "upstream-"+name+" "+host {
			t.Fatalf("%s: got %d %q", host, resp.StatusCode, body)
		}
		if got := resp.TLS.PeerCertificates[0].DNSNames; len(got) != 1 || got[0] != host {
			t.Errorf("%s: the Sentinel's certificate is for %v", host, got)
		}
		r := w.rec.wait(t, i+1)[i]
		if r.Action != record.Open || r.Host != host || r.Status != 200 {
			t.Errorf("record = %+v, want open of %s", r, host)
		}
	}
}

func TestAWildcardOpenedConnectionTakesOnlyItsOwnName(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	up := w.tlsUpstream("a.apps.example.com", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	w.start(`
hosts:
  - name: "*.apps.example.com"
    upstream_ca: %UPCA%
    credentials:
      - place: bearer
        surrogate: ` + surrogate + `
        source: { file: %KEY% }
  - name: exact.apps.example.com
    upstream_ca: %UPCA%
    credentials:
      - place: bearer
        surrogate: ` + otherSurrogate + `
        source: { file: %KEY% }
`)
	w.to("203.0.113.12:443")
	w.route("a.apps.example.com:443", up)
	w.route("exact.apps.example.com:443", up)
	c := w.client(w.ca)

	tests := []struct {
		name, url, host, auth, reason string
	}{
		// Another name the wildcard answers for is still not the SNI.
		{"a Host that is another name under it", "https://a.apps.example.com/", "b.apps.example.com", surrogate, "host-mismatch"},
		// The full name's registration wins: the wildcard's surrogate is another host's there.
		{"the wildcard's surrogate on the full name", "https://exact.apps.example.com/", "", surrogate, string(credentials.ReasonSurrogate)},
	}
	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, _ := http.NewRequest(http.MethodGet, tt.url, nil)
			req.Header.Set("Authorization", "Bearer "+tt.auth)
			if tt.host != "" {
				req.Host = tt.host
			}
			resp, err := c.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			_ = resp.Body.Close()
			if resp.StatusCode != 403 {
				t.Errorf("got %d, want 403", resp.StatusCode)
			}
			r := w.rec.wait(t, i+1)[i]
			if r.Action != record.Deny || r.Reason != tt.reason {
				t.Errorf("record = %+v, want deny for %s", r, tt.reason)
			}
		})
	}
	if n := hits.Load(); n != 0 {
		t.Errorf("the upstream was asked %d times", n)
	}
}
