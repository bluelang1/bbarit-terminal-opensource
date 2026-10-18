import { sanitizeCliOutput, stripSelectionPayload } from '../components/harness-utils';

export interface HarnessResponsePipelineContext {
  provider?: string;
  sanitizeCliTrace?: boolean;
  stripSelection?: boolean;
  trim?: boolean;
}

type ResponseMiddleware = (text: string, ctx: HarnessResponsePipelineContext) => string;

const sanitizeCliTraceMiddleware: ResponseMiddleware = (text, ctx) => {
  if (!ctx.sanitizeCliTrace) return text;
  return ctx.provider === 'kimi-cli' ? sanitizeCliOutput(text) : text;
};

const stripSelectionMiddleware: ResponseMiddleware = (text, ctx) => {
  if (!ctx.stripSelection) return text;
  return stripSelectionPayload(text);
};

const trimMiddleware: ResponseMiddleware = (text, ctx) => {
  if (ctx.trim === false) return text;
  return text.trim();
};

const DEFAULT_PIPELINE: ResponseMiddleware[] = [
  sanitizeCliTraceMiddleware,
  stripSelectionMiddleware,
  trimMiddleware,
];

export function runHarnessResponsePipeline(
  text: string,
  ctx: HarnessResponsePipelineContext = {},
): string {
  return DEFAULT_PIPELINE.reduce((current, middleware) => middleware(current, ctx), String(text || ''));
}

export function sanitizeHarnessCliResult(text: string, provider: string): string {
  return runHarnessResponsePipeline(text, {
    provider,
    sanitizeCliTrace: true,
    stripSelection: false,
    trim: true,
  });
}

export function renderHarnessStagePreview(text: string, provider: string): string {
  return runHarnessResponsePipeline(text, {
    provider,
    sanitizeCliTrace: true,
    stripSelection: true,
    trim: true,
  });
}
