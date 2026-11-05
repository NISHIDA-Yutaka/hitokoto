# ひとこと探偵

1語のヒントで通じ合う、2人用の協力推理ゲーム。各自の端末で遊ぶ Web アプリ。
盤面の25語から、協力者15人を制限時間内に見つける。黒幕は1回まで許され、2回目で迷宮入りになる。
手番のあとは、AI（Jev）がヒントの通じ度を出してツッコミを入れる。

## 構成

- `src/game.js` ルール判定（通信や DB を知らない）
- `src/view.js` 受け取る人ごとの表示内容。相方の面と狙いはゲーム終了まで入れない
- `src/review.js` ツッコミと感想戦
- `src/jev.js` Jev への問い合わせ。ヒントと盤面の単語だけを送る
- `src/db.js` PostgreSQL の読み書き。1操作1トランザクションで、ゲーム行をロックする
- `src/server.js` HTTP と WebSocket、荒らし対策の上限
- `public/` 画面（ビルドなし）。表示と入力だけで、判定は持たない

## 見た目

昭和の探偵小説の表紙のような、平らな刷り色の世界。画像ファイルは使わず、絵はすべて SVG で描いている。
ゲームの部品は探偵の小道具に置き換えている。ヒントは電報、タイマーはマッチ、正解数は正の字、狙いは赤鉛筆の丸、候補は押しピンの付箋、正解は朱肉の検印、黒幕は封蝋と規制線。
`og.png` は URL を送ったときのプレビュー画像。

## 候補の印

推理する側は札に何枚でも付箋を付けられ、相方の画面にも同じ印が出る。答えは付箋の札の「確定」で出す。
手番中だけの目印なのでサーバーのメモリに持ち、DB には入れない。手番が変わるか、部屋の全員が切断すると消える。

盤面の札は作り直さず、変わった所だけ更新する（`morphBoard`）。札の動きをつなげるため。

## 一人で動作確認する

部屋を作ったあとの待機画面で「一人で動作確認する」を押すと、相方の席もそのブラウザが取る。
「相方の席に替わる」で2つの席を行き来して最後まで遊べる。ブラウザだけの機能で、サーバーから見ると2人の接続と同じ。

## 開発

`hitokoto-dev` ユーザーで作業する。

```sh
psql -d hitokoto_dev -f migrations/001_init.sql   # 初回だけ
psql -d hitokoto_dev -f seed/words.sql            # 初回だけ
pnpm install
PGHOST=/var/run/postgresql PGDATABASE=hitokoto_dev pnpm test
PORT=3071 HOST=127.0.0.1 PGHOST=/var/run/postgresql PGDATABASE=hitokoto_dev node src/server.js
```

手元から見るときは `ssh -L 3071:127.0.0.1:3071 kagoya`。

## 本番

- https://hitokoto.133-18-185-116.sslip.io 、ポート 3070、`/healthz`
- 環境変数の秘密は `/etc/apps/hitokoto.env`（`TYPESAFE_API_KEY`）。空なら AI ツッコミなしで動く
- テーブルの変更は `sudo -u postgres psql -d hitokoto -f migrations/<file>.sql`。コミットの本文に「本番作業:」を書いて自動デプロイを止める
- 身内ネタの単語はこのリポジトリに入れず、本番 DB に `inside_joke = true` で入れる
