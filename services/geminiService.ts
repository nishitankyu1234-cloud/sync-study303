import { GoogleGenAI, Type } from "@google/genai";
import { TestQuestion, UserProfile } from "../types";

// 1. 環境変数から複数のAPIキーを取得するロジック
const getApiKeys = (): string[] => {
  const keys = Object.entries(import.meta.env)
    .filter(([key, value]) => key.startsWith('VITE_GEMINI_API_KEY_') && value)
    .map(([_, value]) => value as string);
  
  return keys.length > 0 ? keys : [import.meta.env.VITE_GEMINI_API_KEY_1]; // フォールバック
};

const API_KEYS = getApiKeys();
let currentKeyIndex = 0;

/**
 * 使用するAPIキーを順番に切り替える（ラウンドロビン）
 */
const getNextAiInstance = () => {
  const key = API_KEYS[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  return new GoogleGenAI({ apiKey: key });
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
  const maxRetries = 2;
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let yielded = false;
    try {
      // リトライ時も新しいインスタンス（＝次のAPIキー）を取得するようにループ内で呼ぶ
      const ai = getNextAiInstance();
      const systemInstruction = generateSystemInstruction(userProfile);

      const chat = ai.chats.create({
        model: MODEL_TEXT,
        history: history,
        config: { systemInstruction }
      });

      // ...（画像処理とメッセージ送信のロジックは変更なし）
      
      const result = await chat.sendMessageStream({ /* ... */ });

      for await (const chunk of result) {
        yielded = true;
        yield chunk.text;
      }
      return;
    } catch (error) {
      if (yielded) throw error;
      console.error(`Attempt ${attempt + 1} with Key ${currentKeyIndex} failed:`, error);
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
};

// generateTestQuestions も同様に getNextAiInstance() を使うよう修正
