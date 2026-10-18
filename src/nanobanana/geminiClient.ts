/**
 * geminiClient.ts — Shared Gemini AI client for NanoBanana services
 */
import { GoogleGenAI } from '@google/genai';
import { STORAGE_KEY_GEMINI_API_KEY } from '../components/SettingsPanel';
import { kvGet } from '../hooks/useKV';

export async function getGeminiApiKey(): Promise<string | null> {
  try {
    return ((await kvGet(STORAGE_KEY_GEMINI_API_KEY)) || '').trim() || null;
  } catch {
    return null;
  }
}

export async function createGeminiClient(): Promise<GoogleGenAI> {
  const apiKey = await getGeminiApiKey();
  if (!apiKey) throw new Error('Gemini API 키가 설정되지 않았습니다. 설정 > Gemini API에서 키를 입력하세요.');
  return new GoogleGenAI({ apiKey });
}

/** Extract first image data URL from Gemini response */
export function extractImageFromResponse(response: any): string | null {
  if (response.candidates?.[0]?.content?.parts) {
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      }
    }
  }
  return null;
}

/** Extract all images from Gemini response */
export function extractAllImagesFromResponse(response: any): string[] {
  const images: string[] = [];
  if (response.candidates?.[0]?.content?.parts) {
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        images.push(`data:${part.inlineData.mimeType};base64,${part.inlineData.data}`);
      }
    }
  }
  return images;
}

/** Extract text from Gemini response */
export function extractTextFromResponse(response: any): string {
  if (response.candidates?.[0]?.content?.parts) {
    for (const part of response.candidates[0].content.parts) {
      if (part.text) return part.text;
    }
  }
  return '';
}

/** Current project directory — set by NanoBananaPanel */
let _projectDir = '';
export function setNanoBananaProjectDir(dir: string) { _projectDir = dir; }

/** Get base output dir: {projectDir}/docs/img */
async function getOutputDir(_subfolder: string): Promise<string> {
  if (_projectDir) return `${_projectDir}/docs/img`;
  const { invoke } = await import('@tauri-apps/api/core');
  const home = await invoke<string>('get_home_dir');
  return `${home}/Documents/docs/img`;
}

/** Save a base64 data URL image to {project}/NanoBanana/{subfolder}/ */
export async function saveGeneratedImage(dataUrl: string, subfolder: string, filename: string): Promise<string | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const dir = await getOutputDir(subfolder);
    await invoke('create_directory', { path: dir });
    const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '');
    const ext = dataUrl.includes('image/png') ? 'png' : dataUrl.includes('image/jpeg') ? 'jpg' : 'png';
    const fullPath = `${dir}/${filename}.${ext}`;
    await invoke('write_file_base64', { path: fullPath, base64Data: base64 });
    return fullPath;
  } catch {
    return null;
  }
}

/** Get the NanoBanana output directory path */
export async function getNanoBananaDir(subfolder: string): Promise<string> {
  try {
    return await getOutputDir(subfolder);
  } catch {
    return 'docs/img';
  }
}

export const GEMINI_MODELS = {
  imageProHigh: 'gemini-3-pro-image-preview',
  imageFlash: 'gemini-3.1-flash-image-preview',
  imagen4: 'imagen-4.0-generate-001',
  textPro: 'gemini-3.1-pro-preview',
  videoFast: 'veo-3.1-fast-generate-preview',
  tts: 'gemini-2.5-flash-preview-tts',
} as const;
