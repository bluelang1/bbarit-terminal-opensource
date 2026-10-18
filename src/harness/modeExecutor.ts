import { createGeminiClient, extractImageFromResponse, extractTextFromResponse, GEMINI_MODELS } from '../nanobanana/geminiClient';
import { decomposeTask, runCliPrompt, type CliProvider, type DecomposedTask } from './cliRuntime';
import type { WorkflowExecutionProfile } from './workflow';
import { extractArtifacts, type Artifact } from '../components/harness-utils';

export type HarnessModeExecutorProvider = 'atlascloud';

export interface ImageGenerationResult {
  content: string;
  images?: string[];
  durationMs: number;
  followups: string[];
}

export interface VideoGenerationResult {
  content: string;
  images?: string[];
  artifacts?: Artifact[];
  durationMs: number;
  followups: string[];
}

export type UltraExecutionResult =
  | { kind: 'pending-decompose'; tasks: DecomposedTask[] }
  | { kind: 'fallback-response'; content: string; artifacts: Artifact[]; durationMs: number };

export function detectRequestedImageCount(prompt: string): number {
  const patterns = [
    /(?:^|\D)([1-4])\s*(?:images?|imgs?|pictures?|variations?)\b/i,
    /(?:^|\D)([1-4])\s*(?:개|장)\b/i,
    /([1-4])\s*(?:개의|장의)\s*(?:이미지|사진|그림)/i,
    /(?:이미지|사진|그림)\s*([1-4])\s*(?:개|장)/i,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match) return Math.max(1, Math.min(4, Number(match[1])));
  }
  return 1;
}

export async function executeImageGenerationMode(
  messageText: string,
  startTime: number,
): Promise<ImageGenerationResult> {
  const client = await createGeminiClient();
  const imageCount = detectRequestedImageCount(messageText);
  const response = await client.models.generateImages({
    model: GEMINI_MODELS.imagen4,
    prompt: messageText,
    config: {
      numberOfImages: imageCount,
      aspectRatio: '1:1',
    } as any,
  });
  const images = (response as any).generatedImages
    ?.map((generatedImage: any) => generatedImage?.image?.imageBytes)
    .filter(Boolean)
    .map((imageBytes: string) => `data:image/png;base64,${imageBytes}`) || [];
  return {
    content: images.length > 0
      ? `${images.length} image${images.length > 1 ? 's' : ''} generated for: "${messageText}"`
      : `Image generation finished for: "${messageText}"`,
    images: images.length > 0 ? images : undefined,
    durationMs: Date.now() - startTime,
    followups: [
      'Restyle this image',
      'Edit the result',
      'Generate more variations',
    ],
  };
}

export async function executeVideoGenerationMode(
  messageText: string,
  startTime: number,
): Promise<VideoGenerationResult> {
  const client = await createGeminiClient();
  const response = await client.models.generateContent({
    model: GEMINI_MODELS.imageFlash,
    contents: [{
      role: 'user',
      parts: [{
        text: `Create a detailed video production plan with storyboard for: ${messageText}\n\nInclude:\n1. Video concept & style\n2. Scene-by-scene storyboard (5-8 scenes)\n3. For each scene: visual description, camera angle, duration, narration/dialogue\n4. Music/sound suggestions\n5. Generate a key frame image for the first scene.`,
      }],
    }],
    config: { responseModalities: ['TEXT', 'IMAGE'] },
  });
  const imageUrl = extractImageFromResponse(response);
  const textContent = extractTextFromResponse(response);
  return {
    content: textContent || 'Video storyboard generated.',
    images: imageUrl ? [imageUrl] : undefined,
    artifacts: extractArtifacts(textContent),
    durationMs: Date.now() - startTime,
    followups: [
      'Expand the scene list',
      'Rewrite the narration',
      'Regenerate the storyboard',
    ],
  };
}

export async function executeUltraMode(
  messageText: string,
  startTime: number,
  provider: CliProvider,
  workDir: string,
  enabledProviders: CliProvider[],
  executionProfile: WorkflowExecutionProfile,
): Promise<UltraExecutionResult> {
  const decomposed = await decomposeTask(
    messageText,
    provider,
    workDir,
    enabledProviders,
    executionProfile.decomposeTimeoutSecs,
  );

  if (decomposed.length > 0) {
    return { kind: 'pending-decompose', tasks: decomposed };
  }

  const fallbackResult = await runCliPrompt(
    provider,
    messageText,
    workDir,
    executionProfile.directConversationTimeoutSecs,
  );
  return {
    kind: 'fallback-response',
    content: fallbackResult || '(empty)',
    artifacts: extractArtifacts(fallbackResult || ''),
    durationMs: Date.now() - startTime,
  };
}
