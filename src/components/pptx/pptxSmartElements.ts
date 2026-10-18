import type { SlideElement } from './types';
import { uid } from './types';
import type { PptxDesignTheme } from './pptxDesignThemes';

const text = (
  x: number,
  y: number,
  w: number,
  h: number,
  value: string,
  fontSize = 12,
  extra: Partial<SlideElement> = {},
): SlideElement => ({
  id: uid(),
  type: 'text',
  x,
  y,
  w,
  h,
  text: value,
  fontSize,
  fontColor: '#111827',
  ...extra,
});

const rect = (x: number, y: number, w: number, h: number, fillColor: string, extra: Partial<SlideElement> = {}): SlideElement => ({
  id: uid(),
  type: 'rect',
  x,
  y,
  w,
  h,
  fillColor,
  borderWidth: 0,
  ...extra,
});

const line = (x: number, y: number, w: number, color: string, borderWidth = 1): SlideElement => ({
  id: uid(),
  type: 'line',
  x,
  y,
  w,
  h: 1,
  borderColor: color,
  borderWidth,
});

export function buildEditablePptxTableElements(theme: PptxDesignTheme, x = 11, y = 20): SlideElement[] {
  const cols = ['Metric', 'Current', 'Target'];
  const rows = [
    ['Revenue', '$84K', '$120K'],
    ['Activation', '42%', '55%'],
    ['Retention', '68%', '75%'],
  ];
  const colWidths = [26, 18, 18];
  const rowH = 8;
  const elements: SlideElement[] = [
    text(x, y - 9, 62, 7, 'Editable Table', 24, { bold: true, fontColor: theme.primaryColor }),
  ];

  let cursorX = x;
  cols.forEach((col, idx) => {
    elements.push(rect(cursorX, y, colWidths[idx], rowH, theme.primaryColor));
    elements.push(text(cursorX + 1.2, y + 2, colWidths[idx] - 2.4, 4, col, 12, {
      bold: true,
      fontColor: theme.bgColor,
      textAlign: idx === 0 ? 'left' : 'center',
    }));
    cursorX += colWidths[idx];
  });

  rows.forEach((row, rowIdx) => {
    cursorX = x;
    const fill = rowIdx % 2 === 0 ? theme.surfaceColor : theme.surfaceAltColor;
    row.forEach((cell, colIdx) => {
      elements.push(rect(cursorX, y + rowH * (rowIdx + 1), colWidths[colIdx], rowH, fill, {
        borderWidth: 1,
        borderColor: theme.bgColor,
      }));
      elements.push(text(cursorX + 1.2, y + rowH * (rowIdx + 1) + 2, colWidths[colIdx] - 2.4, 4, cell, 12, {
        bold: colIdx === 0,
        fontColor: theme.textColor,
        textAlign: colIdx === 0 ? 'left' : 'center',
      }));
      cursorX += colWidths[colIdx];
    });
  });

  return elements;
}

export function buildEditablePptxBarChartElements(theme: PptxDesignTheme, x = 11, y = 20): SlideElement[] {
  const data = [
    ['Q1', 35],
    ['Q2', 52],
    ['Q3', 68],
    ['Q4', 84],
  ];
  const chartW = 64;
  const chartH = 42;
  const baseY = y + chartH;
  const barGap = 4;
  const barW = (chartW - barGap * (data.length - 1)) / data.length;
  const elements: SlideElement[] = [
    text(x, y - 9, 64, 7, 'Editable Bar Chart', 24, { bold: true, fontColor: theme.primaryColor }),
    rect(x, y, chartW, chartH + 8, theme.surfaceColor, { opacity: 0.55 }),
    line(x + 4, baseY, chartW - 8, theme.mutedTextColor, 1),
  ];

  data.forEach(([label, rawValue], idx) => {
    const value = Number(rawValue);
    const h = Math.max(4, (value / 100) * (chartH - 8));
    const barX = x + 5 + idx * (barW + barGap);
    const barY = baseY - h;
    const fill = idx === data.length - 1 ? theme.accentColor : theme.primaryColor;
    elements.push(rect(barX, barY, barW, h, fill));
    elements.push(text(barX, barY - 5.5, barW, 4, `${value}`, 11, {
      bold: true,
      textAlign: 'center',
      fontColor: theme.primaryColor,
    }));
    elements.push(text(barX, baseY + 2, barW, 4, String(label), 11, {
      textAlign: 'center',
      fontColor: theme.mutedTextColor,
    }));
  });

  return elements;
}
