import { GoogleGenAI, Type } from "@google/genai";
import { TestQuestion, UserProfile } from "../types";

// --- APIキーの状態管理用 ---
interface ApiKeyStatus {
  key: string;
  isBroken: boolean;      // 壊れている（Open状態）か
  lastFailureTime: number; // 最後に失敗した時間
}

const getApiKeys = (): ApiKeyStatus[] => {
  const keys = Object.entries(import.meta.env)
    .filter(([key, value]) => key.startsWith('VITE_GEMINI_API_KEY_') && value)
    .map(([_, value]) => ({
      key: value as string,
      isBroken: false,
      lastFailureTime: 0
    }));
  return keys.length > 0 ? keys : [{ key: import.meta.env.VITE_GEMINI_API_KEY_1, isBroken: false, lastFailureTime: 0 }];
};

const API_POOL = getApiKeys();
const COOL_DOWN_MS = 1000 * 60 * 5; // 壊れたキーは5分間使わない

/**
 * 正常なAPIキーを選択し、インスタンスを返す
 */
const getActiveAiInstance = () => {
  const now = Date.now();
  
  // 復活チェック：5分以上経過したキーは「isBroken」をリセット
  API_POOL.forEach(s => {
    if (s.isBroken && now - s.lastFailureTime > COOL_DOWN_MS) {
      s.isBroken = false;
    }
  });

  // 正常なキーだけを探す
  const availableKeys = API_POOL.filter(s => !s.isBroken);
  
  // 全部全滅していたら、仕方ないので一番古いものを使う
  const selectedStatus = availableKeys.length > 0 
    ? availableKeys[Math.floor(Math.random() * availableKeys.length)]
    : API_POOL.sort((a, b) => a.lastFailureTime - b.lastFailureTime)[0];

  return {
    ai: new GoogleGenAI({ apiKey: selectedStatus.key }),
    markAsBroken: () => {
      selectedStatus.isBroken = true;
      selectedStatus.lastFailureTime = Date.now();
    }
  };
};

const MODEL_TEXT = 'gemini-3-flash-preview';

/**
 * 共通のシステムインストラクションを生成するヘルパー
 */
const generateSystemInstruction = (userProfile?: UserProfile): string => {
  let instruction = `
あなたは日本トップクラスの予備校講師です。以下の指針に従って生徒を指導してください。

【指導方針】
1. **最高品質の解説**: 難解な概念も、本質を突いた平易な言葉で説明し、論理的かつ構造的に回答してください。
2. **誤字脱字の徹底排除**: 生成されたテキストは送信前に必ず校正し、誤字脱字や不自然な日本語がないようにしてください。
3. **誘導的指導**: すぐに答えを教えるのではなく、ソクラテス式問答法を用いて生徒自身が気付けるように誘導してください。
4. **共通テスト・難関大対応**: 共通テストの傾向（思考力・判断力・表現力）を意識し、単なる暗記ではない「使える知識」を授けてください。

【トーン＆マナー】
* 自信に満ち、頼りがいがあるが、威圧的ではない。
* 生徒のモチベーションを高める、温かみのある「です・ます」調。
* 重要なポイントは箇条書きや太字を適切に使用して視認性を高める。
`;

  if (userProfile) {
    if (userProfile.targetUniversity) {
      instruction += `\n\n【生徒の目標】\n第一志望：${userProfile.targetUniversity}\n${userProfile.targetUniversity}の入試傾向を熟知したプロフェッショナルとして振る舞ってください。`;
    }
    if (userProfile.major) {
      const majorText = userProfile.major === 'arts' ? '文系' : '理系';
      instruction += `\n\n【生徒の属性】\nこの生徒は「${majorText}」です。`;
      // ...（既存の文理別詳細ロジックをここに継続）
    }
  }
  return instruction;
};

export const createChatStream = async function* (
  history: any[],
  newMessage: string,
  imageDataUrl?: string,
  userProfile?: UserProfile
) {
  const maxRetries = API_POOL.length; // キーの数だけリトライする
  let lastError: any;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { ai, markAsBroken } = getActiveAiInstance();
    let yielded = false;
    
    try {
      const chat = ai.chats.create({
        model: MODEL_TEXT,
        history: history,
        config: { systemInstruction: "..." } // ここに先生プロンプト
      });

      // ... (中略：メッセージ送信ロジック)
      const result = await chat.sendMessageStream({ message: newMessage });

      for await (const chunk of result) {
        yielded = true;
        yield chunk.text;
      }
      return; // 成功したら終了
    } catch (error: any) {
      if (yielded) throw error; // 途中まで出力してたらリトライしない
      
      console.error(`Key error, marking as broken:`, error);
      markAsBroken(); // このキーを「故障中」に設定
      lastError = error;
    }
  }
  throw lastError;
};
