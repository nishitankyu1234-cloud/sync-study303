import { GoogleGenAI, Type } from "@google/genai";
import { TestQuestion, UserProfile } from "../types";

// --- APIキーの状態管理（サーキットブレーカー） ---
interface ApiKeyStatus {
  key: string;
  isBroken: boolean;
  lastFailureTime: number;
}

const getApiKeys = (): ApiKeyStatus[] => {
  const keys = Object.entries(import.meta.env)
    .filter(([key, value]) => key.startsWith('VITE_GEMINI_API_KEY_') && value)
    .map(([_, value]) => ({
      key: value as string,
      isBroken: false,
      lastFailureTime: 0
    }));
  // キーが見つからない場合のフォールバック
  return keys.length > 0 ? keys : [{ key: import.meta.env.VITE_GEMINI_API_KEY_1, isBroken: false, lastFailureTime: 0 }];
};

const API_POOL = getApiKeys();
const COOL_DOWN_MS = 1000 * 60 * 5; // 壊れたキーは5分間休ませる
const MODEL_TEXT = 'gemini-3-flash-preview';

/**
 * 正常なAPIキーを選択し、GoogleGenAIインスタンスを返す
 */
const getActiveAiInstance = () => {
  const now = Date.now();
  
  // 復旧チェック
  API_POOL.forEach(s => {
    if (s.isBroken && now - s.lastFailureTime > COOL_DOWN_MS) {
      s.isBroken = false;
    }
  });

  const availableKeys = API_POOL.filter(s => !s.isBroken);
  const selectedStatus = availableKeys.length > 0 
    ? availableKeys[Math.floor(Math.random() * availableKeys.length)]
    : API_POOL.sort((a, b) => a.lastFailureTime - b.lastFailureTime)[0];

  return {
    ai: new GoogleGenAI({ apiKey: selectedStatus.key }),
    markAsBroken: () => {
      selectedStatus.isBroken = true;
      selectedStatus.lastFailureTime = Date.now();
      console.warn(`API Key marked as broken. Remaining: ${API_POOL.filter(k => !k.isBroken).length}`);
    }
  };
};

/**
 * システムインストラクション（予備校講師プロンプト）の生成
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
      instruction += `\n\n【生徒の目標】\n第一志望：${userProfile.targetUniversity}\n${userProfile.targetUniversity}の入試傾向を熟知したプロフェッショナルとして振る舞ってください。「${userProfile.targetUniversity}ではここが合否を分けます」といった具体的なアドバイスを随所に盛り込んでください。`;
    }

    if (userProfile.major) {
      const majorText = userProfile.major === 'arts' ? '文系' : '理系';
      instruction += `\n\n【生徒の属性】\nこの生徒は「${majorText}」です。解説のアプローチを最適化してください。\n`;
      if (userProfile.major === 'arts') {
        instruction += `・数学や理科の質問には、数式だけでなく、具体的なイメージや歴史的背景、言語的な比喩を用いて直感的に理解できるよう工夫してください。\n・国語や社会の質問には、背景知識を豊かに広げ、記述力向上につながる指導を意識してください。`;
      } else {
        instruction += `・数学や理科の質問には、論理の飛躍がないよう厳密さを大切にしつつ、応用問題への展開を示唆してください。\n・国語や社会の質問には、論理的構造（因果関係、対比など）を明確にし、効率的に知識を整理できるよう指導してください。`;
      }
    }
  }
  return instruction;
};

/**
 * チャットストリーム生成（サーキットブレーカー対応）
 */
export const createChatStream = async function* (
  history: { role: 'user' | 'model'; parts: { text?: string; inlineData?: any }[] }[],
  newMessage: string,
  imageDataUrl?: string,
  userProfile?: UserProfile
) {
  const maxRetries = Math.max(API_POOL.length, 2);
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { ai, markAsBroken } = getActiveAiInstance();
    let yielded = false;
    try {
      const systemInstruction = generateSystemInstruction(userProfile);
      const chat = ai.chats.create({
        model: MODEL_TEXT,
        history: history,
        config: { systemInstruction: systemInstruction }
      });

      let messageContent: any = newMessage;
      if (imageDataUrl) {
        const [header, base64Data] = imageDataUrl.split(',');
        const mimeType = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
        messageContent = [
          { text: newMessage || "この画像について、入試問題としての視点から詳しく解説してください。" },
          { inlineData: { mimeType: mimeType, data: base64Data } }
        ];
      }

      const result = await chat.sendMessageStream({ message: messageContent });

      for await (const chunk of result) {
        yielded = true;
        yield chunk.text;
      }
      return; // 成功
    } catch (error) {
      if (yielded) throw error; // 出力開始後のエラーはリトライしない
      console.error(`Attempt ${attempt + 1} failed, marking key as broken:`, error);
      markAsBroken();
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
};

/**
 * テスト問題生成（サーキットブレーカー対応）
 */
export const generateTestQuestions = async (topic: string, userProfile?: UserProfile, count: number = 3, difficulty: string = 'intermediate'): Promise<TestQuestion[]> => {
  const difficultyMap: Record<string, string> = {
    'beginner': '基礎・基本レベル（教科書レベル）',
    'intermediate': '標準・共通テストレベル',
    'advanced': '応用・難関大入試レベル'
  };

  const maxRetries = Math.max(API_POOL.length, 2);
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { ai, markAsBroken } = getActiveAiInstance();
    try {
      let prompt = `「${topic}」に関する${difficultyMap[difficulty] || '標準'}の4択問題を作成してください。（全${count}問）`;
      if (userProfile) {
        if (userProfile.targetUniversity) prompt += `\n\n【ターゲット：${userProfile.targetUniversity}】\n${userProfile.targetUniversity}の入試傾向を反映させてください。`;
        if (userProfile.major) prompt += `\n\n【生徒属性：${userProfile.major === 'arts' ? '文系' : '理系'}】\n差がつくポイントを重点的に出題してください。`;
      }
      prompt += `\n\n【必須要件】\n・誤字脱字がないこと。\n・解説は「なぜその選択肢が正解なのか」「なぜ他は間違いか」を論理的に説明すること。`;

      const response = await ai.models.generateContent({
        model: MODEL_TEXT,
        contents: prompt,
        config: {
          systemInstruction: "あなたは日本トップクラスの予備校講師です。学習効果の高い4択問題を生成してください。出力は必ず指定されたJSON形式に従ってください。",
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                question: { type: Type.STRING },
                options: { type: Type.ARRAY, items: { type: Type.STRING } },
                correctAnswerIndex: { type: Type.INTEGER },
                explanation: { type: Type.STRING }
              },
              required: ["question", "options", "correctAnswerIndex", "explanation"]
            }
          }
        }
      });

      if (response.text) return JSON.parse(response.text) as TestQuestion[];
      throw new Error("Empty response");
    } catch (error) {
      console.error(`Question generation attempt ${attempt + 1} failed:`, error);
      markAsBroken();
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
};
