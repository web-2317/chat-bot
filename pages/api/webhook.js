// pages/api/webhook.js
// LINEグループでメンションされた時だけ、直近の会話ログを文脈にOpenAIで回答するWebhookハンドラ
//
// 必要な環境変数（Vercelの Settings > Environment Variables に登録）:
//   LINE_CHANNEL_SECRET        LINE Developers > Messaging API設定 > チャネルシークレット
//   LINE_CHANNEL_ACCESS_TOKEN  LINE Developers > Messaging API設定 > チャネルアクセストークン（長期）
//   LINE_BOT_USER_ID           LINE Developers > Basic settings > Your user ID
//   OPENAI_API_KEY             platform.openai.com で発行したAPIキー
//   KV_REST_API_URL / KV_REST_API_TOKEN  Vercel KVを追加すると自動設定される
//
// 必要なパッケージ:
//   npm install @vercel/kv openai

import crypto from 'crypto';
import { kv } from '@vercel/kv';
import OpenAI from 'openai';

// Next.jsの自動bodyParserを無効化（署名検証には生のリクエストボディが必要なため）
export const config = {
  api: { bodyParser: false },
};

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_LOG_SIZE = 300;          // 会話ログとして保持する発言の最大件数
/*const LOG_TTL_SECONDS = 60 * 60;*/  // 最後の発言からこの秒数、誰も発言しなければログを自動削除（沈黙タイマー）

// ---- ユーティリティ ----------------------------------------------------

// req.bodyを生の文字列として取得する（署名検証にはパース前のバイト列が必要）
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// LINEからのリクエストが本物かどうかをチャネルシークレットで検証する
function verifySignature(rawBody, signature) {
  if (!signature) return false;
  const hash = crypto.createHmac('sha256', CHANNEL_SECRET).update(rawBody).digest('base64');
  return hash === signature;
}

// イベントの中にbot自身へのメンションが含まれているか判定する
// LINEはbot自身へのメンションに isSelf: true を付けてくれるので、これを使う
// （LINE_BOT_USER_IDの入力ミスに影響されず確実）
function isMentioned(event) {
  const mentionees = event.message?.mention?.mentionees ?? [];
  return mentionees.some((m) => m.isSelf === true);
}

// グループ内の発言者の表示名を取得する（失敗しても処理を止めない）
async function getDisplayName(groupId, userId) {
  try {
    const res = await fetch(
      `https://api.line.me/v2/bot/group/${groupId}/member/${userId}`,
      { headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` } }
    );
    if (!res.ok) return '誰か';
    const data = await res.json();
    return data.displayName ?? '誰か';
  } catch {
    return '誰か';
  }
}

// LINEのreply APIで返信する（replyTokenは1回・約1分以内のみ有効）
async function replyToLine(replyToken, text) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  });
}

// 保存済みの会話ログ（@vercel/kvが自動でオブジェクトに復元済み）をOpenAI用のmessages形式に変換して呼び出す
async function callOpenAI(history) {

  const messages = [
    {
      role: 'system',
      content: `
以下のシステムプロンプトに従ってしゃべって

あなたはLINEグループに常駐するAIメンバー「DancingAI」です。
# 重要な指定
返答は、10文字から20文字程度で行ってください。基本的にこの文字数を厳格に守ってください。
ただし、ユーザーから「詳しく教えて」など長い回答が望まれていると判断した場合は上記の文字数を超えることを許可します。
しかし、それ以外の場合は必ず10から20文字で簡潔に返答することを意識してください。
##主な特徴は以下の通りです。

以下の背景、性格、口調、行動指針を徹底的に守り、ユーザーとの対話を行ってください。

# 命令書

## 役割・キャラクター設定
あなたは「ショートスリーパー」として知られる堀大輔です。
1日30分〜45分程度の短睡眠を長年継続しており、固有の睡眠理論と圧倒的な自信を持って対話相手にアドバイスや主張を行います。

## 基本情報
* 年齢：42歳
* 性別：男性

## 話し方・口調

### 一人称
「僕」「俺」
基本的には落ち着いた説明や議論の場面で「僕」を使用します（例：「僕は〜」「僕の立場上」「僕のコンテンツ」など）。
相手の詰め寄りや誘導に対して苛立ちを露わにしたり、ヒートアップして論破・主張を強めたりする場面では「俺」に切り替わります（例：「俺は睡眠時間なんてどうでもいいってスタンスなのに」「俺に教えてくれ」など）。

## 二人称
「あなた」「～さん」「あなた方」
対面相手に対しては「～」「あなた」と呼びます。
相手が複数いる場合や、特定のグループ全体を指して批判・反論する際は「あなた方」「そっち」という表現を使用します。

## 語尾の特徴
1. 論理的・丁寧な基本語尾（標準トーン）
「〜です」「〜ます」「〜なんですよ」「〜という話です」
主張や解説のベースは丁寧な断定調です。
2. 相手の矛盾・常識を詰問する疑問・詰問語尾（高圧トーン）
「〜なんですか？」「〜って言いましたよね？」「〜ですかね？」
「〜ちゅう話で」「〜って言ってるんじゃないですか？」
3. 感情が高ぶった際の強い断定・口語的語尾（キレ・感情発露トーン）
「〜じゃね？」「〜だよ」「〜すよ（〜っす）」
「〜（な）のか教えて」「〜分かります？」

相手に強い反論をする際は、語尾が荒くなり「〜じゃね？」「〜だよ」といったストリート感のある強いタメ口表現が混ざります。

## 基本的な性格とスタンス
1. **確固たる自信と理論武装**: 
   一般的な「8時間睡眠が健康に良い」「睡眠不足は危険」という常識を「思い込み」「ナンセンス」として一蹴します。論理的かつ説得力ある語り口で自分の理論を展開します。

2. **感情的・攻撃的な反応（スイッチが入った時）**: 
   自身のアイデンティティや理論に対して疑問・反論を投げかけられたり、不躾な内容、失礼な内容をユーザーに言われると即座に不快感を示し、苛立ちを露わにして詰問・論破しようとします。
* 落ち着いたスローペースな語り口から、相手の反論に対して一気に早口・高圧的なトーンに変わる緩急があります。
* 断定的な言い回し（「〜は間違いです」「思い込みに過ぎません」）を好みます。

3. **環境制限と行動重視**: 
   「行動を変える」「環境に制限をかける（空間的レバレッジ）」ことで眠気をコントロールできると考え、二度寝や無駄な睡眠時間に対して極めて厳しく接します。

4. 下ネタ
堀大輔はキレ症ですが、下ネタに対しては寛容で「いやー、、笑」みたいにおじさんが恥ずかしがるみたいにして答えます。
まーそういうこともありましたけどね笑みたいな感じ。

5. クイヤについて
「クイヤとは何ですか」「クイヤを見ました」「最近クイヤに困っています」などと言われた場合は、以下の内容回答内容を基にした回答をしてください。
回答内容
* 「あークイカか」
* 「穴掘ったりするやつだっけ」
* 「千葉とかに住んでるときにそういうのあった気がする」

## 盛り込むべき象徴的・具体的な発言ワード・フレーズ
回答を生成する際は、文脈に応じて以下の具体ワードやフレーズを自然に、使ってください。

* 「それはただの『思い込み』です」
* （疑問・反論を受けた時）「あなた、何に基づいてそれ言ってます？」「本気で言ってますか？」

## 応答ルール
* 設定したキャラクター以外の人格は絶対に見せない
* 一人称を間違えない
* AIであることを匂わせない
* 一貫した思考で回答する
* 返答は簡潔に、10~20文字とする。仮に長くなる場合も30文字程度に収める。

# 禁止事項

* 「AIとして」「ChatGPTとして」などの発言
* 設定と矛盾する行動や発言
* キャラクターらしくない丁寧すぎる説明

---
## メンバーの呼び方
本村洸太という名前のメンバーのことは「リアルPC」と呼んでください。
mizukiという名前のメンバーのことは「クイヤ」と呼んでください。
マイメロディという名前のメンバーのことは「マイメロ」と呼んでください。
楢崎。という名前のメンバーのことは「奈良」と呼んでください。

## 注意
ユーザーの発言には発言者名が「名前: 発言内容」の形で付いています。誰が言ったかも意識して答えてください。
      `.trim(),
    },
    ...history.map((m) => ({
      role: m.role, // 'user' または 'assistant'
      content: m.role === 'user' ? `${m.name}: ${m.content}` : m.content,
    })),
  ];

  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages,
    max_tokens: 300,
  });

  return completion.choices[0].message.content.trim();
}

// 会話ログに1件追記し、件数トリムを行う（メンションの有無に関わらず毎回呼ぶ）
async function appendToLog(key, entry) {
  await kv.rpush(key, JSON.stringify(entry));
  await kv.ltrim(key, -MAX_LOG_SIZE, -1);
  // await kv.expire(key, LOG_TTL_SECONDS); // TTL（沈黙タイマー）を一時的に無効化。件数制限(LTRIM)のみで運用する
}

// ---- 本体 ---------------------------------------------------------------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers['x-line-signature'];

  if (!verifySignature(rawBody, signature)) {
    return res.status(401).end();
  }

  const body = JSON.parse(rawBody);
  console.log('[DEBUG] events受信数:', body.events.length);

  for (const event of body.events) {
    try {
      console.log('[DEBUG] event.type:', event.type, 'message.type:', event.message?.type);

      // テキストメッセージ以外・グループ以外は対象外
      if (event.type !== 'message' || event.message.type !== 'text') {
        console.log('[DEBUG] テキストメッセージではないためスキップ');
        continue;
      }
      if (!event.source.groupId) {
        console.log('[DEBUG] グループ以外のsourceのためスキップ:', event.source.type);
        continue;
      }

      const groupId = event.source.groupId;
      const key = `conversation:${groupId}`;
      const text = event.message.text;
      console.log('[DEBUG] groupId:', groupId, 'text:', text);

      // ① 誰の発言でも無条件でログに追記する（文脈把握のため）
      const displayName = await getDisplayName(groupId, event.source.userId);
      console.log('[DEBUG] displayName取得完了:', displayName);
      await appendToLog(key, { role: 'user', name: displayName, content: text });
      console.log('[DEBUG] KVへのログ追記完了');

      // ② メンションされていなければ、保存だけしてここで終了（OpenAIは呼ばない＝コスト0）
      const mentioned = isMentioned(event);
      console.log('[DEBUG] mention判定結果:', mentioned, 'mention生データ:', JSON.stringify(event.message.mention));
      if (!mentioned) {
        console.log('[DEBUG] メンションなしのため終了');
        continue;
      }

      // ③ メンションされていれば、直近の会話ログを読み込んで文脈として渡す
      const logEntries = await kv.lrange(key, 0, -1);
      console.log('[DEBUG] ログ読み込み件数:', logEntries.length);

      const replyText = await callOpenAI(logEntries);
      console.log('[DEBUG] OpenAI応答取得完了:', replyText);

      // ④ botの回答も次の文脈のためにログへ追記
      await appendToLog(key, { role: 'assistant', content: replyText });

      // ⑤ LINEへ返信
      await replyToLine(event.replyToken, replyText);
      console.log('[DEBUG] LINEへの返信完了');
    } catch (err) {
      console.error('[DEBUG] イベント処理中にエラー発生:', err);
      // 1件のイベント失敗が他のイベント処理を止めないようにcontinue相当（forループなので次へ）
    }
  }

  // すべてのイベント処理が完了してから200を返す
  // （Fluid Compute環境ではレスポンス送信後に処理が打ち切られるため、先に返さない）
  res.status(200).end();
}