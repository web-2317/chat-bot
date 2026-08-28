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
const BOT_USER_ID = process.env.LINE_BOT_USER_ID;

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
function isMentioned(event) {
  const mentionees = event.message?.mention?.mentionees ?? [];
  return mentionees.some((m) => m.userId === BOT_USER_ID);
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

// 保存済みの会話ログ（JSON文字列の配列）をOpenAI用のmessages形式に変換して呼び出す
async function callOpenAI(rawLogEntries) {
  const history = rawLogEntries.map((entry) => JSON.parse(entry));

  const messages = [
    {
      role: 'system',
      content:
        'あなたはLINEグループチャットに参加しているアシスタントです。' +
        '直前までの会話の流れを踏まえて、フランクかつ簡潔に日本語で答えてください。' +
        'ユーザーの発言には発言者名が「名前: 発言内容」の形で付いています。誰が言ったかも意識して答えてください。',
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

// 会話ログに1件追記し、件数トリムとTTL延長を行う（メンションの有無に関わらず毎回呼ぶ）
async function appendToLog(key, entry) {
  await kv.rpush(key, JSON.stringify(entry));
  await kv.ltrim(key, -MAX_LOG_SIZE, -1);
  await kv.expire(key, LOG_TTL_SECONDS);
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

  // LINEには先に200を返しておく（reply自体は後段でreplyTokenを使って行う）
  res.status(200).end();

  const body = JSON.parse(rawBody);

  for (const event of body.events) {
    try {
      // テキストメッセージ以外・グループ以外は対象外
      if (event.type !== 'message' || event.message.type !== 'text') continue;
      if (!event.source.groupId) continue;

      const groupId = event.source.groupId;
      const key = `conversation:${groupId}`;
      const text = event.message.text;

      // ① 誰の発言でも無条件でログに追記する（文脈把握のため）
      const displayName = await getDisplayName(groupId, event.source.userId);
      await appendToLog(key, { role: 'user', name: displayName, content: text });

      // ② メンションされていなければ、保存だけしてここで終了（OpenAIは呼ばない＝コスト0）
      if (!isMentioned(event)) continue;

      // ③ メンションされていれば、直近の会話ログを読み込んで文脈として渡す
      const logEntries = await kv.lrange(key, 0, -1);
      const replyText = await callOpenAI(logEntries);

      // ④ botの回答も次の文脈のためにログへ追記
      await appendToLog(key, { role: 'assistant', content: replyText });

      // ⑤ LINEへ返信
      await replyToLine(event.replyToken, replyText);
    } catch (err) {
      console.error('イベント処理中にエラー:', err);
      // 1件のイベント失敗が他のイベント処理を止めないようにcontinue相当（forループなので次へ）
    }
  }
}