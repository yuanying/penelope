import type { HouseActor } from "@penelope/contract";

/** A name that ends in a Latin letter or digit stands apart from the particle after it. */
const spaced = (name: string) => (/[\x20-\x7e]$/.test(name) ? `${name} ` : name);
const names = (residents: readonly HouseActor[]) => residents.map(({ name }) => name).join("・");

export const words = {
  loginTitle: "家",
  login: "GitHub でログイン",
  loginNote: "この家の住人だけが入れます。",
  logout: "ログアウト",
  account: (name: string) => `${name}（自分）のメニュー`,
  opening: "家につないでいます…",
  skip: "会話へ移動",

  plan: "間取り",
  nobody: "誰もいません",
  people: (count: number) => `${count} 人`,
  full: (count: number, capacity: number) => `${count}/${capacity} 満員`,
  seats: (count: number, capacity: number) => `${count}/${capacity}`,
  here: "ここにいる",
  peeking: "覗いている",
  peek: "覗く",
  peekRoom: (room: string) => `${room}を覗く`,
  enter: "入る",
  enterRoom: (room: string) => `${room}に入る`,
  enterHere: "ここに入る",
  entering: "入室を確認しています。",
  readOnlyRoom: "読み取り専用の会話",
  readOnlyBody: "この部屋に入室すると発言できます。",
  fullNoEntry: "満員で入れません",
  fullNoEntryOf: (capacity: number) => `満員なので入れません（定員 ${capacity}）`,
  openTalk: "会話を開く",
  openTalkOf: (room: string) => `${room}の会話を開く`,
  away: "出かけている",
  allHome: "みんな家にいます",
  inRoom: (room: string) => `${room}にいる`,
  nowhereDock: "どの部屋にもいません。部屋を選んで入ると話せます。",
  silent: "まだ誰も話していません",
  unreadCount: (count: number) => `まだ読んでいない発言 ${count} 件`,

  self: "（自分）",
  asleepMark: "（寝ている）",
  awake: "起きている",
  asleepUntil: (time: string) => `寝ている・${time} に起きる`,
  disconnected: "つながっていない",
  thisScreen: "この画面を開いている",
  screenOpen: "画面を開いている",
  sleepiness: "眠気",
  sleepinessOf: (value: number) => `眠気 ${value}（上限は 100）`,
  chat: "1:1",
  chatWith: (name: string) => `${name}と 1:1 で話す（別の画面で開く）`,

  myRoom: "自分のいる部屋",
  peekedRoom: "覗いている部屋",
  roomLog: (room: string) => `${room}の会話`,
  residentsOf: (room: string) => `${room}の住人`,
  showResidents: "この部屋の住人を見る",
  leave: "部屋を出る",
  backToPlan: "間取りに戻る",
  backTo: (room: string) => `${room}に戻る`,
  stopPeeking: "覗くのをやめる",
  peekNote: "覗いています。住人には分かりません。ここでは話せません。",
  nowhereTitle: "いまはどの部屋にもいません",
  nowhereBody: "部屋に入ると、その部屋の住人と話せます。覗くだけなら、住人には分かりません。",
  openPlan: "間取りを開く",
  older: "前の会話を読む",
  reading: "読み込んでいます…",
  emptyRoom: "この部屋では、まだ誰も話していません。",
  came: (who: string, room: string) => `${spaced(who)}が${room}に来た`,
  left: (who: string, room: string) => `${spaced(who)}が${room}を出た`,
  undelivered: (residents: readonly HouseActor[]) => `${spaced(names(residents))}は寝ているので届いていません。起きた後にも届きません。`,

  speakIn: (room: string) => `${room}で話す`,
  speakPlaceholder: (room: string) => `${room}で話す…`,
  to: "宛先",
  pickTo: "@ 宛先",
  pickToLabel: "この部屋の住人から宛先を選ぶ",
  noCandidates: "当てはまる住人がいません。",
  nobodyElse: "この部屋には、ほかに誰もいません。",
  asleepNoReach: "寝ている・届かない",
  removeTo: (name: string) => `${name}を宛先から外す`,
  enterHint: "Enter で送る・Shift+Enter で改行",
  unsentRefused: "送れなかった発言",
  unsentUnknown: "送れたか確かめられなかった発言",
  unsentUnknownHint: "会話に出ていれば記録されています。出ていなくても、もう一度送ると重なることがあります。",
  resend: "もう一度送る",
  resendWithout: (gone: readonly string[]) => `${gone.join("・")}を宛先から外して送る`,
  goneFromRoom: (gone: readonly string[]) => `${spaced(gone.join("・"))}は、いまこの部屋にいません。`,
  showAll: "全文を開く",
  showLess: "畳む",
  backToField: "入力欄に戻す",
  discard: "捨てる",

  down: "接続が切れました。つなぎ直しています。",
  downBody: "つながるまで話せません。接続が切れても居場所は変わりません。",
  refused: "家につながりません。しばらくしてつなぎ直します。",
  retry: "いますぐつなぎ直す",
  enterFull: (room: string) => `${room}は満員で入れませんでした。`,
  enterFailed: (room: string) => `${room}に入れたか確かめられませんでした。`,
  failed: "うまくいきませんでした。もう一度試してください。",
  logoutUnconfirmed: "ログアウトを確かめられませんでした。まだログインしたままです。",
  logoutAgain: "もう一度ログアウトする",
  dismiss: "知らせを閉じる",

  today: "今日",
  yesterday: "昨日",
} as const;

/** A button's name with the count its badge shows: the badge alone names nothing. */
export const withUnread = (label: string, count: number) => (count > 0 ? `${label}（${words.unreadCount(count)}）` : label);

const time = new Intl.DateTimeFormat("ja-JP", { hour: "numeric", minute: "2-digit" });
const date = new Intl.DateTimeFormat("ja-JP", { month: "long", day: "numeric", weekday: "short" });
const dateWithYear = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });

export function timeOf(at: string): string {
  return time.format(new Date(at));
}

export function dayOf(at: string, now: number = Date.now()): string {
  const day = new Date(at);
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (diff === 0) return words.today;
  if (diff === 1) return words.yesterday;
  return (day.getFullYear() === today.getFullYear() ? date : dateWithYear).format(day);
}
