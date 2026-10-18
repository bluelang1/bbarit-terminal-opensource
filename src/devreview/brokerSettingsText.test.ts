import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brokerSettingsText } from './brokerSettingsText';

describe('brokerSettingsText', () => {
  it('does not contain committed mojibake markers or a UTF-8 BOM', () => {
    const source = readFileSync(join(process.cwd(), 'src/devreview/brokerSettingsText.ts'), 'utf8');

    expect(source.charCodeAt(0)).not.toBe(0xfeff);
    expect(source).not.toMatch(/[\uFFFD\u0080-\u009F]/);
    expect(source).not.toMatch(/(^|\s|\/\/|\/\*)\?\?[A-Za-z]|[A-Za-z]\?\?[A-Za-z]/);
    expect(source).not.toMatch(/[\uC338\uBD31]/);
  });

  it('uses English chrome when broker language is English', () => {
    const text = brokerSettingsText('en');

    expect(text.title).toBe('Broker Agent');
    expect(text.language).toBe('Broker language');
    expect(text.reviewMode).toBe('Review mode');
    expect(text.browserReview).toBe('BBARIT Browser test');
    expect(text.reviewModeOptions.off).toBe('Off - skip reviewer');
    expect(text.reviewModeOptions.very_careful).toBe('Very careful');
    expect(text.optionEnglish).toBe('English');
    expect(text.optionKorean).toBe('Korean');
  });

  it('uses Korean chrome when broker language is Korean', () => {
    const text = brokerSettingsText('ko');

    expect(text.title).toBe('브로커 에이전트');
    expect(text.language).toBe('브로커 언어');
    expect(text.reviewMode).toBe('리뷰 모드');
    expect(text.browserReview).toBe('빠릿 브라우저 테스트');
    expect(text.reviewModeOptions.off).toBe('끄기 - 리뷰어 건너뛰기');
    expect(text.reviewModeOptions.light).toBe('대충');
    expect(text.reviewModeOptions.normal).toBe('보통');
    expect(text.reviewModeOptions.careful).toBe('꼼꼼히');
    expect(text.reviewModeOptions.very_careful).toBe('아주 꼼꼼히');
    expect(text.optionEnglish).toBe('영어');
    expect(text.optionKorean).toBe('한국어');
  });
});
