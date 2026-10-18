/**
 * dailyNotes.ts
 *
 * Obsidian-style daily notes: one note per day under {notesDir}/daily,
 * plus template variable expansion shared with note templates.
 */

/** Format a date as YYYY-MM-DD in local time. */
export function formatDailyDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Format a time as HH:mm in local time. */
export function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Absolute path of the daily note for the given date. */
export function getDailyNotePath(notesDir: string, d: Date): string {
  const sep = notesDir.includes('\\') ? '\\' : '/';
  return `${notesDir}${sep}daily${sep}${formatDailyDate(d)}.md`;
}

/**
 * Expand template variables: {{title}}, {{date}}, {{time}}, {{datetime}},
 * {{yesterday}}, {{tomorrow}}.
 */
export function applyTemplateVariables(content: string, vars: { title: string; date: Date }): string {
  const { title, date } = vars;
  const yesterday = new Date(date);
  yesterday.setDate(yesterday.getDate() - 1);
  const tomorrow = new Date(date);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return content
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{date\}\}/g, formatDailyDate(date))
    .replace(/\{\{time\}\}/g, formatTime(date))
    .replace(/\{\{datetime\}\}/g, `${formatDailyDate(date)} ${formatTime(date)}`)
    .replace(/\{\{yesterday\}\}/g, formatDailyDate(yesterday))
    .replace(/\{\{tomorrow\}\}/g, formatDailyDate(tomorrow));
}

/**
 * Build the initial content for a new daily note.
 * Uses the given template if provided, otherwise a minimal default with
 * prev/next day navigation links.
 */
export function buildDailyNoteContent(d: Date, template?: string): string {
  const title = formatDailyDate(d);
  if (template && template.trim()) {
    return applyTemplateVariables(template, { title, date: d });
  }
  const yesterday = new Date(d);
  yesterday.setDate(yesterday.getDate() - 1);
  const tomorrow = new Date(d);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return `# ${title}\n\n<< [[${formatDailyDate(yesterday)}]] | [[${formatDailyDate(tomorrow)}]] >>\n\n`;
}
