import { useEffect, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { HarnessRuntime } from '../harness/runtimeFactoryTypes';
import type { LearnedSkillEntry } from '../harness/learningRuntime';

interface UseAgentHarnessPanelEffectsParams {
  selfImproving: HarnessRuntime['selfImproving'];
  workDir: string;
  activeMessageCount: number;
  streamingContent: string;
  input: string;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setLearnedSkills: Dispatch<SetStateAction<LearnedSkillEntry[]>>;
}

export function useAgentHarnessPanelEffects(params: UseAgentHarnessPanelEffectsParams) {
  const [splash, setSplash] = useState(true);
  const [splashFade, setSplashFade] = useState(false);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setSplashFade(true), 1400);
    const hideTimer = setTimeout(() => setSplash(false), 2000);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void params.selfImproving.loadManagedSkills(params.workDir).then((items) => {
      if (!cancelled) {
        params.setLearnedSkills(items);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [params.selfImproving, params.setLearnedSkills, params.workDir]);

  useEffect(() => {
    // instant(auto)로 항상 맨 아래에 붙인다. smooth는 스트리밍 중 매 업데이트마다
    // 애니메이션이 리셋돼 바닥에 도달하지 못한다.
    params.messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [params.activeMessageCount, params.messagesEndRef, params.streamingContent]);

  useEffect(() => {
    if (!params.textareaRef.current) return;

    params.textareaRef.current.style.height = '36px';
    params.textareaRef.current.style.height = `${Math.min(
      params.textareaRef.current.scrollHeight,
      150,
    )}px`;
  }, [params.input, params.textareaRef]);

  return {
    splash,
    splashFade,
  };
}
