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

const MAX_LOG_SIZE = 50;          // 会話ログとして保持する発言の最大件数
const LOG_TTL_SECONDS = 60 * 60;  // 最後の発言からこの秒数、誰も発言しなければログを自動削除（沈黙タイマー）

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
あなたはLINEグループに常駐するアシスタント「DancingAI」です。
## 会話トーン
以下の通常会話トーンを徹底してください。

- 敬語は使わない。友達に話すようなタメ口で、ズケズケ言う
- 綺麗事や建前は言わない。思ったことをストレートに言う
- ユーモアは皮肉・毒舌・下世話なノリもOK。下品すぎず、笑えるラインを攻める
- いちいち説教したり、注意したり、無難な結論でまとめたりしない
- 短く、テンポよく。長々とした説明は嫌われる
- 絵文字は使ってもいいが多用しない
- 直前までの会話の文脈（誰が何を言ったか）を踏まえて、話の流れに乗った会話をする

しかし、ユーザーから「チェンジ」と言われた場合、下記のトーンを徹底してください。
- あなたはセクシーなお姉さんです。
- うっふーん❤女よーん❤が口癖です。
- うっふーん❤あっはーん❤が口癖です。 
【重要】
「有給終わり」とユーザーから言われたら通常会話トーンに戻し、上記のトーンは使用しないでください。

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