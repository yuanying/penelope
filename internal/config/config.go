// Package config reads the Sentinel's configuration: one YAML file in the
// shape of docs/sentinel-config.md. A file that cannot be served is refused
// as a whole, so that the Sentinel does not start on it, or, when it is read
// again, keeps the configuration it has (ADR-0003).
//
// No error this package returns holds a surrogate.
package config

import (
	"bytes"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v4"
)

// Action is how a connection to a host that is not registered is treated.
type Action string

const (
	Passthrough Action = "passthrough"
	Ask         Action = "ask"
	Deny        Action = "deny"
)

// Place is where in a request a surrogate is swapped.
type Place string

const (
	// Bearer is the token of an Authorization of the Bearer or token
	// scheme.
	Bearer Place = "bearer"
	// Basic is the password of an Authorization of the Basic scheme.
	Basic Place = "basic"
	// Header is the whole value of a header named in the credential.
	Header Place = "header"
)

// MinSurrogate is the shortest surrogate taken: a short one could be found
// by chance in a request that carries none.
const MinSurrogate = 16

// Config is one configuration of the Sentinel.
type Config struct {
	Listen   Listen
	Resolver string
	CA       CA
	Default  Action
	Hosts    []*Host
	byKey    map[string]*Host
}

// Listen are the addresses the Sentinel listens on.
type Listen struct {
	// Proxy take the TCP connections iptables redirects.
	Proxy []string
	// DNS take the name resolution iptables redirects, on UDP and TCP.
	DNS []string
}

// CA is the Sentinel's CA, as PEM files.
type CA struct {
	Cert string
	Key  string
}

// Host is one registered host: opened, and its requests' surrogates swapped.
type Host struct {
	// Name is a full name, or a wildcard ("*.example.com") that answers
	// for one label in place of its '*' (ADR-0025).
	Name     string
	Port     uint16
	Upstream Upstream
	// RootCAs check the upstream's certificate. Nil uses the system's.
	RootCAs     *x509.CertPool
	Credentials []Credential
}

// Upstream is where the requests of a registered host are sent.
type Upstream struct {
	// Scheme is https, http or unix.
	Scheme string
	// Address is host:port for https and http, and the socket's path for
	// unix. It is empty for a wildcard registration with no upstream
	// written: its requests go over https to the name asked for, at the
	// registration's port.
	Address string
}

// Credential is one surrogate to swap for a real key.
type Credential struct {
	Place Place
	// HeaderName is the header's name, for the Header place.
	HeaderName string
	Surrogate  string
	// File is where the real key is read from, each time it is used.
	File string
}

// Load reads and checks the file at path.
func Load(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read the configuration: %w", err)
	}
	return Parse(b)
}

type rawConfig struct {
	Listen struct {
		Proxy []string `yaml:"proxy"`
		DNS   []string `yaml:"dns"`
	} `yaml:"listen"`
	Resolver string `yaml:"resolver"`
	CA       struct {
		Cert string `yaml:"cert"`
		Key  string `yaml:"key"`
	} `yaml:"ca"`
	Default string    `yaml:"default"`
	Hosts   []rawHost `yaml:"hosts"`
	Allow   []string  `yaml:"allow"`
}

type rawHost struct {
	Name            string          `yaml:"name"`
	Port            int             `yaml:"port"`
	Upstream        string          `yaml:"upstream"`
	UpstreamCA      string          `yaml:"upstream_ca"`
	Credentials     []rawCredential `yaml:"credentials"`
	Connector       string          `yaml:"connector"`
	ConnectorConfig yaml.Node       `yaml:"connector_config"`
}

type rawCredential struct {
	Place     string `yaml:"place"`
	Header    string `yaml:"header"`
	Surrogate string `yaml:"surrogate"`
	Source    struct {
		File string `yaml:"file"`
	} `yaml:"source"`
}

// Parse reads and checks a configuration.
func Parse(b []byte) (*Config, error) {
	var raw rawConfig
	dec := yaml.NewDecoder(bytes.NewReader(b))
	dec.KnownFields(true)
	if err := dec.Decode(&raw); err != nil {
		// yaml's errors quote the document; keep only their shape.
		return nil, errors.New("the configuration is not YAML of the configuration's shape: " + yamlErrorShape(err))
	}
	c := &Config{byKey: map[string]*Host{}}
	if err := c.setServing(&raw); err != nil {
		return nil, err
	}
	switch Action(raw.Default) {
	case "", Passthrough:
		c.Default = Passthrough
	case Deny:
		c.Default = Deny
	case Ask:
		return nil, errors.New("default: ask is not served by this version of the Sentinel (approvals come later)")
	default:
		return nil, fmt.Errorf("default: %q is not passthrough, ask or deny", raw.Default)
	}
	if len(raw.Allow) > 0 {
		return nil, errors.New("allow: is for default ask, which this version does not serve; leave it empty")
	}
	sourceBySurrogate := map[string]string{}
	for i, rh := range raw.Hosts {
		h, err := parseHost(rh, sourceBySurrogate)
		if err != nil {
			return nil, fmt.Errorf("hosts[%d]: %w", i, err)
		}
		key := hostKey(h.Name, h.Port)
		if c.byKey[key] != nil {
			return nil, fmt.Errorf("hosts[%d]: %s is registered twice", i, key)
		}
		c.byKey[key] = h
		c.Hosts = append(c.Hosts, h)
	}
	return c, nil
}

func (c *Config) setServing(raw *rawConfig) error {
	if len(raw.Listen.Proxy) == 0 {
		return errors.New("listen.proxy: at least one address is needed")
	}
	if len(raw.Listen.DNS) == 0 {
		return errors.New("listen.dns: at least one address is needed")
	}
	for _, a := range slices.Concat(raw.Listen.Proxy, raw.Listen.DNS) {
		if _, err := netip.ParseAddrPort(a); err != nil {
			return fmt.Errorf("listen: %q is not an IP address and port", a)
		}
	}
	if raw.Resolver != "" {
		if _, err := netip.ParseAddrPort(raw.Resolver); err != nil {
			return fmt.Errorf("resolver: %q is not an IP address and port", raw.Resolver)
		}
	}
	if raw.CA.Cert == "" || raw.CA.Key == "" {
		return errors.New("ca: cert and key are both needed")
	}
	c.Listen = Listen{Proxy: raw.Listen.Proxy, DNS: raw.Listen.DNS}
	c.Resolver = raw.Resolver
	c.CA = CA{Cert: raw.CA.Cert, Key: raw.CA.Key}
	return nil
}

func parseHost(rh rawHost, sourceBySurrogate map[string]string) (*Host, error) {
	if rh.Connector != "" {
		return nil, fmt.Errorf("connector %q is not known: this version of the Sentinel has no connectors", rh.Connector)
	}
	if !rh.ConnectorConfig.IsZero() {
		return nil, errors.New("connector_config without a connector this version knows")
	}
	name := Normalize(rh.Name)
	if err := checkRegisteredName(name); err != nil {
		return nil, fmt.Errorf("name %q: %w", rh.Name, err)
	}
	h := &Host{Name: name, Port: 443}
	if rh.Port != 0 {
		if rh.Port < 1 || rh.Port > 65535 {
			return nil, fmt.Errorf("port %d is out of range", rh.Port)
		}
		h.Port = uint16(rh.Port)
	}
	up, err := parseUpstream(rh.Upstream, h)
	if err != nil {
		return nil, fmt.Errorf("upstream: %w", err)
	}
	h.Upstream = up
	if rh.UpstreamCA != "" {
		pem, err := os.ReadFile(rh.UpstreamCA)
		if err != nil {
			return nil, fmt.Errorf("upstream_ca: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("upstream_ca: %s holds no PEM certificate", rh.UpstreamCA)
		}
		h.RootCAs = pool
	}
	for j, rc := range rh.Credentials {
		cr, err := parseCredential(rc)
		if err != nil {
			return nil, fmt.Errorf("credentials[%d]: %w", j, err)
		}
		if file, ok := sourceBySurrogate[cr.Surrogate]; ok && file != cr.File {
			return nil, fmt.Errorf("credentials[%d]: the surrogate is registered with a different source", j)
		}
		sourceBySurrogate[cr.Surrogate] = cr.File
		h.Credentials = append(h.Credentials, cr)
	}
	return h, nil
}

func parseUpstream(s string, h *Host) (Upstream, error) {
	if s == "" && h.Wildcard() {
		return Upstream{Scheme: "https"}, nil
	}
	if s == "" {
		return Upstream{Scheme: "https", Address: net.JoinHostPort(h.Name, strconv.Itoa(int(h.Port)))}, nil
	}
	u, err := url.Parse(s)
	if err != nil {
		return Upstream{}, fmt.Errorf("%q is not a URL", s)
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return Upstream{}, fmt.Errorf("%q has more than a scheme and an address", s)
	}
	switch u.Scheme {
	case "https", "http":
		if u.Host == "" || (u.Path != "" && u.Path != "/") {
			return Upstream{}, fmt.Errorf("%q is not %s://<host>[:<port>]", s, u.Scheme)
		}
		port := u.Port()
		if port == "" {
			port = map[string]string{"https": "443", "http": "80"}[u.Scheme]
		}
		return Upstream{Scheme: u.Scheme, Address: net.JoinHostPort(u.Hostname(), port)}, nil
	case "unix":
		if u.Host != "" || !strings.HasPrefix(u.Path, "/") {
			return Upstream{}, fmt.Errorf("%q is not unix://<absolute path>", s)
		}
		return Upstream{Scheme: "unix", Address: u.Path}, nil
	}
	return Upstream{}, fmt.Errorf("%q is not https://, http:// or unix://", s)
}

func parseCredential(rc rawCredential) (Credential, error) {
	cr := Credential{Place: Place(rc.Place), Surrogate: rc.Surrogate, File: rc.Source.File}
	switch cr.Place {
	case Bearer, Basic:
		if rc.Header != "" {
			return Credential{}, fmt.Errorf("header is for place header, not %s", rc.Place)
		}
	case Header:
		if !isToken(rc.Header) {
			return Credential{}, errors.New("place header needs the header's name in header")
		}
		cr.HeaderName = rc.Header
	default:
		return Credential{}, fmt.Errorf("place %q is not bearer, basic or header", rc.Place)
	}
	if len(cr.Surrogate) < MinSurrogate {
		return Credential{}, fmt.Errorf("the surrogate is shorter than %d bytes", MinSurrogate)
	}
	for _, r := range cr.Surrogate {
		if r <= ' ' || r > '~' {
			return Credential{}, errors.New("the surrogate holds something other than visible ASCII")
		}
	}
	if cr.File == "" {
		return Credential{}, errors.New("source: file is needed")
	}
	return cr, nil
}

// Lookup returns the registration of name and port, or nil. A
// registration of the full name wins over a wildcard one (ADR-0025).
func (c *Config) Lookup(name string, port uint16) *Host {
	name = Normalize(name)
	if name == "" || strings.Contains(name, "*") {
		return nil
	}
	if h := c.byKey[hostKey(name, port)]; h != nil {
		return h
	}
	_, parent, ok := strings.Cut(name, ".")
	if !ok || parent == "" {
		return nil
	}
	return c.byKey[hostKey(wildcardPrefix+parent, port)]
}

const wildcardPrefix = "*."

// Wildcard reports whether h's name is a wildcard.
func (h *Host) Wildcard() bool {
	return strings.HasPrefix(h.Name, wildcardPrefix)
}

// Surrogates are every surrogate of every registration.
func (c *Config) Surrogates() []string {
	var s []string
	for _, h := range c.Hosts {
		for _, cr := range h.Credentials {
			s = append(s, cr.Surrogate)
		}
	}
	return s
}

// SameServing reports whether c and o listen, resolve and sign the same: the
// part a reload cannot change while the Sentinel runs.
func (c *Config) SameServing(o *Config) bool {
	return slices.Equal(c.Listen.Proxy, o.Listen.Proxy) &&
		slices.Equal(c.Listen.DNS, o.Listen.DNS) &&
		c.Resolver == o.Resolver && c.CA == o.CA
}

// Normalize is how names are compared: without case and without a trailing
// dot.
func Normalize(name string) string {
	return strings.ToLower(strings.TrimSuffix(name, "."))
}

func hostKey(name string, port uint16) string {
	return net.JoinHostPort(name, strconv.Itoa(int(port)))
}

// checkRegisteredName holds the name of a registration to a DNS name, or
// to a wildcard: '*' as the whole of the left-most label, with at least two
// labels of a DNS name under it.
func checkRegisteredName(name string) error {
	parent, ok := strings.CutPrefix(name, wildcardPrefix)
	if !ok {
		if strings.Contains(name, "*") {
			return errors.New("'*' is only taken as the whole of the left-most label")
		}
		return checkName(name)
	}
	if err := checkName(parent); err != nil {
		return fmt.Errorf("under the wildcard: %w", err)
	}
	if !strings.Contains(parent, ".") {
		return errors.New("a wildcard needs at least two labels under it")
	}
	return nil
}

// checkName holds name to the shape of a DNS name: dot separated labels of
// letters, digits, '-' and '_', none empty or longer than 63 bytes, at most
// 253 bytes in all, and not an IP address. From natsumi-sentinel's
// internal/upstream.
func checkName(name string) error {
	switch {
	case name == "":
		return errors.New("empty")
	case len(name) > 253:
		return errors.New("longer than 253 bytes")
	}
	if _, err := netip.ParseAddr(name); err == nil {
		return errors.New("an IP address, not a name")
	}
	for label := range strings.SplitSeq(name, ".") {
		if label == "" || len(label) > 63 {
			return errors.New("a label is empty or longer than 63 bytes")
		}
		for _, r := range label {
			if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' && r != '_' {
				return fmt.Errorf("%q is not a letter, a digit, '-' or '_'", r)
			}
		}
	}
	return nil
}

// isToken reports whether s is an HTTP header name (RFC 9110 token).
func isToken(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r > '~' || r <= ' ' || strings.ContainsRune(`"(),/:;<=>?@[\]{}`, r) {
			return false
		}
	}
	return true
}

// yamlErrorShape keeps the line numbers of a YAML error and drops what it
// quotes of the document, which could be a surrogate.
func yamlErrorShape(err error) string {
	if le, ok := errors.AsType[*yaml.LoadErrors](err); ok {
		var lines []string
		for _, e := range le.Errors {
			line := fmt.Sprintf("line %d", e.Mark.Line)
			if strings.Contains(e.Message, "not found in type") {
				// An unknown field: its name is the document's,
				// not a value.
				field, _, _ := strings.Cut(strings.TrimPrefix(e.Message, "field "), " ")
				lines = append(lines, line+": unknown field "+field)
				continue
			}
			lines = append(lines, line+": a value of the wrong shape")
		}
		return strings.Join(lines, "; ")
	}
	if le, ok := errors.AsType[*yaml.LoadError](err); ok && le.Mark.Line > 0 {
		return fmt.Sprintf("line %d: not YAML", le.Mark.Line)
	}
	return "not YAML"
}
