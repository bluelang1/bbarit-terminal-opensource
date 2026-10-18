// <select> dropdown option matching.
//
// Ported from browser-use's dropdown_options / select_dropdown actions: form-filling
// handles text inputs, but a native <select> needs picking the right OPTION by its
// visible label (the user says "Large" or "대한민국", not the option's value="42").
// This scores options against a target and returns the value to set. Pure + tested.
//
// D1: Match on the visible LABEL first (what the user sees), then the value, by
//     exact → normalized-exact → substring. Reason: users describe the label; values
//     are often opaque codes. A tie or no match returns null so the caller can ask.

export interface SelectOption { value: string; label: string; index?: number }
export interface SelectMatch { value: string | null; label?: string; index?: number; reason: string; ambiguous: boolean }

function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function matchOption(target: string, options: SelectOption[]): SelectMatch {
  const t = norm(target);
  if (!t) return { value: null, reason: 'empty target', ambiguous: false };
  const opts = (options || []).filter((o) => o && (o.label || o.value));
  if (!opts.length) return { value: null, reason: 'no options', ambiguous: false };

  // 1. exact label (case-insensitive)
  const exactLabel = opts.filter((o) => norm(o.label) === t);
  if (exactLabel.length === 1) return done(exactLabel[0], 'exact label');
  if (exactLabel.length > 1) return { value: exactLabel[0].value, label: exactLabel[0].label, index: exactLabel[0].index, reason: 'multiple exact labels; took first', ambiguous: true };

  // 2. exact value
  const exactValue = opts.find((o) => norm(o.value) === t);
  if (exactValue) return done(exactValue, 'exact value');

  // 3. substring on label (unique wins; tie is ambiguous)
  const subLabel = opts.filter((o) => norm(o.label).includes(t) || t.includes(norm(o.label)));
  if (subLabel.length === 1) return done(subLabel[0], 'label substring');
  if (subLabel.length > 1) return { value: null, reason: `ambiguous: ${subLabel.length} options match "${target}"`, ambiguous: true };

  // 4. substring on value
  const subValue = opts.find((o) => norm(o.value).includes(t));
  if (subValue) return done(subValue, 'value substring');

  return { value: null, reason: `no option matches "${target}"`, ambiguous: false };
}

function done(o: SelectOption, reason: string): SelectMatch {
  return { value: o.value, label: o.label, index: o.index, reason, ambiguous: false };
}
