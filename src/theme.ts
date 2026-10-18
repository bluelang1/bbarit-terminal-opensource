export type FontOption = {
  name: string;
  value: string;
};

export type StyleTheme = {
  name: string;
  bg: string;
  text: string;
  accent: string;
};

// Font options — all fonts are bundled via @font-face or fontsource.
// Tauri WKWebView cannot access system fonts, so only bundled fonts work.
// All fonts must be monospace for proper terminal rendering.
export const FONTS: FontOption[] = [
  // --- English (bundled in public/fonts/) ---
  { name: "Fira Code", value: "'Fira Code', monospace" },
  { name: "JetBrains Mono", value: "'JetBrains Mono', monospace" },
  { name: "Source Code Pro", value: "'Source Code Pro', monospace" },
  { name: "Cascadia Code", value: "'Cascadia Code', monospace" },
  { name: "Hack", value: "'Hack', monospace" },
  // --- Korean monospace (bundled) ---
  { name: "D2Coding", value: "'D2Coding', monospace" },
  { name: "Nanum Gothic Coding", value: "'Nanum Gothic Coding', monospace" },
  // --- Custom (system font picker) ---
  { name: "Custom", value: "" },
];

export const CUSTOM_FONT_INDEX = FONTS.length - 1;

/** Resolve the effective CSS font-family string for a project. */
export function getEffectiveFont(fontIndex: number, customFontFamily?: string): string {
  if (fontIndex === CUSTOM_FONT_INDEX && customFontFamily?.trim()) {
    const name = customFontFamily.trim();
    const quoted = name.includes(' ') || name.includes("'") ? `"${name}"` : name;
    return `${quoted}, monospace`;
  }
  return (FONTS[fontIndex] || FONTS[0]).value;
}

// Style themes.
// Keep ordering stable: we store `styleIndex` in localStorage and reuse it across the app.

// Dark themes
export const DARK_STYLES: StyleTheme[] = [
  { name: "Ocean", bg: "#0f1a24", text: "#b8c5d0", accent: "#5a9eb8" },
  { name: "Forest", bg: "#151f17", text: "#b5c9b8", accent: "#5a8a62" },
  { name: "Sunset", bg: "#1f1815", text: "#d4c4b8", accent: "#c4875a" },
  { name: "Lavender", bg: "#1a1820", text: "#c5bdd0", accent: "#8a7aa0" },
  { name: "Mint", bg: "#151e1c", text: "#b8d0c8", accent: "#5a9a8a" },
  { name: "Rose", bg: "#1f171a", text: "#d0bbc2", accent: "#a86a78" },
  { name: "Sky", bg: "#151a20", text: "#b8c8d8", accent: "#5a8ab8" },
  { name: "Sand", bg: "#1e1c15", text: "#d0c8b5", accent: "#a89060" },
  { name: "Grape", bg: "#1a1520", text: "#c8bbd0", accent: "#7a5a90" },
  { name: "Coral", bg: "#1f1a17", text: "#d0c0b8", accent: "#b87a5a" },
  { name: "Mocha", bg: "#1e1e2e", text: "#cdd6f4", accent: "#89b4fa" },
  { name: "Dracula", bg: "#282a36", text: "#f8f8f2", accent: "#bd93f9" },
  { name: "Nord", bg: "#2e3440", text: "#d8dee9", accent: "#81a1c1" },
  { name: "Tokyo", bg: "#1a1b26", text: "#a9b1d6", accent: "#7aa2f7" },
  { name: "Gruvbox", bg: "#282828", text: "#d5c4a1", accent: "#d79921" },
  { name: "Solarized", bg: "#002b36", text: "#839496", accent: "#268bd2" },
  { name: "OneDark", bg: "#282c34", text: "#abb2bf", accent: "#61afef" },
  { name: "Material", bg: "#263238", text: "#b0bec5", accent: "#80cbc4" },
  { name: "Atom", bg: "#1d1f21", text: "#c5c8c6", accent: "#8abeb7" },
  { name: "Sublime", bg: "#272822", text: "#f8f8f2", accent: "#a6e22e" },
  { name: "Cyber", bg: "#0f0f14", text: "#7accaa", accent: "#9966cc" },
  { name: "Retro", bg: "#181810", text: "#8ac070", accent: "#b8a860" },
  { name: "Matrix", bg: "#0a0f0a", text: "#4a9a4a", accent: "#2a6a2a" },
  { name: "Hacker", bg: "#0f0f0f", text: "#5ab85a", accent: "#3a8a3a" },
  { name: "Neon", bg: "#12081a", text: "#c090b0", accent: "#60a0c0" },
  { name: "Vapor", bg: "#18101f", text: "#b080a8", accent: "#9070b0" },
  { name: "Synth", bg: "#1a151f", text: "#b090c0", accent: "#60b0c0" },
  { name: "Outrun", bg: "#150818", text: "#b06090", accent: "#a050b0" },
  { name: "Blade", bg: "#101018", text: "#a0a0c0", accent: "#b06080" },
  { name: "Tron", bg: "#101820", text: "#70a0b0", accent: "#50b0a0" },
  { name: "Coffee", bg: "#1a1512", text: "#a08870", accent: "#785038" },
  { name: "Midnight", bg: "#0d1117", text: "#c9d1d9", accent: "#58a6ff" },
  { name: "Slate", bg: "#1e293b", text: "#cbd5e1", accent: "#64748b" },
  { name: "Stone", bg: "#1c1917", text: "#a8a29e", accent: "#78716c" },
  { name: "Zinc", bg: "#18181b", text: "#a1a1aa", accent: "#71717a" },
  { name: "Emerald", bg: "#0f1f15", text: "#88c8a0", accent: "#4a9068" },
  { name: "Cyan", bg: "#0f1a1f", text: "#88c0d0", accent: "#4a98a8" },
  { name: "Violet", bg: "#1a1530", text: "#b0a8d0", accent: "#7a70b0" },
  { name: "Fuchsia", bg: "#1f1020", text: "#c0a0c8", accent: "#a060a8" },
  { name: "Pink", bg: "#1f1018", text: "#c8a8b8", accent: "#a07088" },
  { name: "Amber", bg: "#1f1810", text: "#c8b088", accent: "#b08848" },
  { name: "Lime", bg: "#151f10", text: "#a8c888", accent: "#68a048" },
  { name: "Teal", bg: "#101f1e", text: "#88c0b8", accent: "#489890" },
  { name: "Indigo", bg: "#181830", text: "#a0a8d0", accent: "#6870b0" },
  { name: "Red", bg: "#1f1010", text: "#c8a0a0", accent: "#a06060" },
  { name: "Orange", bg: "#1f1510", text: "#c8b0a0", accent: "#b07848" },
  { name: "Yellow", bg: "#1f1a10", text: "#c8c088", accent: "#a89848" },
  { name: "Green", bg: "#101f15", text: "#a0c8a8", accent: "#58a068" },
  { name: "Blue", bg: "#101828", text: "#a0b8d0", accent: "#5880b0" },
  { name: "Purple", bg: "#1a1028", text: "#b8a0d0", accent: "#8060a8" },
];

// Light themes
export const LIGHT_STYLES: StyleTheme[] = [
  { name: "Light", bg: "#ffffff", text: "#333333", accent: "#4a90d9" },
  { name: "Light Warm", bg: "#faf8f5", text: "#3d3632", accent: "#c47030" },
  { name: "Light Cool", bg: "#f5f7fa", text: "#2d3748", accent: "#4a7ab5" },
  { name: "Light Rose", bg: "#fdf5f5", text: "#3d2c2c", accent: "#c06070" },
  { name: "Light Mint", bg: "#f2faf7", text: "#2a3d35", accent: "#40906a" },
  { name: "Light Sand", bg: "#faf7f0", text: "#3d3828", accent: "#a08040" },
  { name: "Solarized Light", bg: "#fdf6e3", text: "#586e75", accent: "#268bd2" },
  { name: "GitHub Light", bg: "#ffffff", text: "#24292e", accent: "#0366d6" },
  { name: "Light Lavender", bg: "#f8f5fd", text: "#342d48", accent: "#7060a8" },
  { name: "Paper", bg: "#f5f0e8", text: "#40382e", accent: "#886840" },
  { name: "Light Slate", bg: "#f6f8fb", text: "#1f2937", accent: "#475569" },
  { name: "Light Seafoam", bg: "#eefaf6", text: "#15362d", accent: "#2f9a7b" },
  { name: "Light Sky", bg: "#f2f8ff", text: "#1f2b3a", accent: "#2f74c9" },
  { name: "Light Meadow", bg: "#f3fbf2", text: "#1f3321", accent: "#2f8f3f" },
  { name: "Light Citrus", bg: "#fff9e8", text: "#3a2f12", accent: "#c88a14" },
  { name: "Light Clay", bg: "#fbf3ee", text: "#3c2a22", accent: "#c06b3b" },
  { name: "Light Cherry", bg: "#fff1f2", text: "#3a1a1c", accent: "#c23a4c" },
  { name: "Light Ice", bg: "#eef7ff", text: "#192a3a", accent: "#2e74b5" },
  { name: "Light Mono", bg: "#fafafa", text: "#111827", accent: "#6b7280" },
  { name: "Light Terminal", bg: "#fcfcf7", text: "#1a1a1a", accent: "#0a7a7a" },
  // Fun light themes
  { name: "Blueprint", bg: "#eaf2ff", text: "#0b1d3a", accent: "#1d4ed8" },
  { name: "Kintsugi", bg: "#fff8ec", text: "#2a241f", accent: "#b69100" },
  { name: "Newspaper", bg: "#f7f1e3", text: "#1f1f1f", accent: "#2f4858" },
  { name: "Cobalt Snow", bg: "#f1f6ff", text: "#081a3a", accent: "#0b5bd3" },
  { name: "Pixel Pop", bg: "#fff0f7", text: "#2b1722", accent: "#ff3ea5" },
  { name: "Lemonade", bg: "#fff6cc", text: "#2c2608", accent: "#f59e0b" },
  { name: "Bento", bg: "#fff2e8", text: "#2e1e14", accent: "#ff6b35" },
  { name: "Matcha Latte", bg: "#f2fbf0", text: "#17311f", accent: "#2f8f3f" },
  { name: "Neon Soda", bg: "#effdf7", text: "#0f2a26", accent: "#00b894" },
  { name: "Frosted Glass", bg: "#f4fbff", text: "#0f2230", accent: "#0ea5e9" },
  // Additional light themes
  { name: "Cream", bg: "#fffdf5", text: "#3d3a30", accent: "#d4a84b" },
  { name: "Vanilla", bg: "#fffef8", text: "#3d3a35", accent: "#c4a46a" },
  { name: "Ivory", bg: "#fffff8", text: "#3d3d38", accent: "#b8a888" },
  { name: "Pearl", bg: "#faf8ff", text: "#383540", accent: "#9a8ab8" },
  { name: "Alabaster", bg: "#fafaf8", text: "#3d3d3a", accent: "#8a9a8a" },
  { name: "Porcelain", bg: "#f8fafc", text: "#2d3748", accent: "#64748b" },
  { name: "Chiffon", bg: "#fffaf0", text: "#3d3828", accent: "#c4a46a" },
  { name: "Linen", bg: "#faf5f0", text: "#3d3830", accent: "#a08060" },
  { name: "Silk", bg: "#fff8f5", text: "#3d3835", accent: "#c49080" },
  { name: "Cashmere", bg: "#f5f0e8", text: "#3d3830", accent: "#b09070" },
  { name: "Cotton", bg: "#ffffff", text: "#2d3748", accent: "#4a7ab5" },
  { name: "Cloud", bg: "#f7fafc", text: "#2d3748", accent: "#5a7a9a" },
  { name: "Mist", bg: "#f0f4f8", text: "#2d3748", accent: "#5a7a9a" },
  { name: "Dew", bg: "#f0f8f4", text: "#2d4838", accent: "#4a9a6a" },
  { name: "Frost", bg: "#f0f8ff", text: "#1a3a5a", accent: "#2f74c9" },
  { name: "Snow", bg: "#ffffff", text: "#1f2937", accent: "#3b82f6" },
  { name: "Blizzard", bg: "#f8fafc", text: "#1e293b", accent: "#0ea5e9" },
  { name: "Winter", bg: "#f1f5f9", text: "#1e293b", accent: "#3b82f6" },
  { name: "Spring", bg: "#f0fdf4", text: "#1f3321", accent: "#22c55e" },
  { name: "Summer", bg: "#fffbeb", text: "#3a2f12", accent: "#f59e0b" },
  { name: "Autumn", bg: "#fff7ed", text: "#3d2815", accent: "#c47030" },
  { name: "Sakura", bg: "#fff1f5", text: "#3d1a25", accent: "#ec4899" },
  { name: "Peach", bg: "#fff5f0", text: "#3d2820", accent: "#f97316" },
  { name: "Lavender Field", bg: "#faf5ff", text: "#3d1a48", accent: "#a855f7" },
  { name: "Mint Garden", bg: "#f0fdf4", text: "#1a3d28", accent: "#10b981" },
  { name: "Ocean Breeze", bg: "#f0f9ff", text: "#0c4a6e", accent: "#0ea5e9" },
  { name: "Morning", bg: "#fffaf0", text: "#3d2815", accent: "#fbbf24" },
  { name: "Noon", bg: "#fffbeb", text: "#3d2f12", accent: "#f59e0b" },
  { name: "Dusk", bg: "#faf5ff", text: "#3d1a3d", accent: "#a855f7" },
  { name: "Twilight", bg: "#f5f3ff", text: "#2d1a3d", accent: "#8b5cf6" },
  { name: "Dawn", bg: "#fff7ed", text: "#3d2815", accent: "#fb923c" },
  { name: "Sunrise", bg: "#fff5f0", text: "#3d2015", accent: "#f97316" },
  { name: "Sunset Glow", bg: "#fff1f2", text: "#3d1a1a", accent: "#ef4444" },
  { name: "Moonlight", bg: "#f8fafc", text: "#1e293b", accent: "#64748b" },
  { name: "Starlight", bg: "#fafafa", text: "#1f2937", accent: "#6b7280" },
  { name: "Daylight", bg: "#ffffff", text: "#111827", accent: "#3b82f6" },
  { name: "Overcast", bg: "#f3f4f6", text: "#1f2937", accent: "#6b7280" },
  { name: "Rainy", bg: "#f1f5f9", text: "#1e293b", accent: "#5a7a9a" },
  { name: "Stormy", bg: "#e2e8f0", text: "#1e293b", accent: "#475569" },
  { name: "Foggy", bg: "#f1f5f9", text: "#334155", accent: "#64748b" },
  { name: "Hazy", bg: "#fafaf8", text: "#3d3d3a", accent: "#a0a090" },
  { name: "Sunny", bg: "#fffbeb", text: "#3d2f12", accent: "#fbbf24" },
  { name: "Bright", bg: "#ffffff", text: "#000000", accent: "#2563eb" },
  { name: "Clean", bg: "#fafafa", text: "#171717", accent: "#525252" },
  { name: "Minimal", bg: "#ffffff", text: "#262626", accent: "#404040" },
  { name: "Simple", bg: "#f5f5f5", text: "#262626", accent: "#525252" },
  { name: "Modern", bg: "#fafafa", text: "#18181b", accent: "#71717a" },
  { name: "Classic", bg: "#f5f5f0", text: "#262626", accent: "#525252" },
  { name: "Elegant", bg: "#fafaf8", text: "#1c1917", accent: "#78716c" },
  { name: "Sophisticated", bg: "#f5f5f5", text: "#262626", accent: "#525252" },
  { name: "Professional", bg: "#ffffff", text: "#0f172a", accent: "#334155" },
  { name: "Corporate", bg: "#f8fafc", text: "#1e293b", accent: "#475569" },
  { name: "Business", bg: "#ffffff", text: "#1f2937", accent: "#4b5563" },
  { name: "Academic", bg: "#fafaf8", text: "#292524", accent: "#78716c" },
  { name: "Medical", bg: "#ffffff", text: "#1e293b", accent: "#0ea5e9" },
  { name: "Legal", bg: "#fafafa", text: "#1c1917", accent: "#44403c" },
  { name: "Financial", bg: "#f8fafc", text: "#0f172a", accent: "#1e293b" },
  { name: "Tech", bg: "#fafafa", text: "#18181b", accent: "#3f3f46" },
  { name: "Startup", bg: "#ffffff", text: "#111827", accent: "#6366f1" },
  { name: "Creative", bg: "#fafafa", text: "#1f2937", accent: "#ec4899" },
  { name: "Artistic", bg: "#faf8ff", text: "#3d1a3d", accent: "#a855f7" },
  { name: "Designer", bg: "#ffffff", text: "#1f2937", accent: "#f97316" },
  { name: "Writer", bg: "#fafaf8", text: "#292524", accent: "#78716c" },
  { name: "Developer", bg: "#fafafa", text: "#1f2937", accent: "#22c55e" },
  { name: "Coder", bg: "#ffffff", text: "#171717", accent: "#3b82f6" },
  { name: "Hacker Light", bg: "#f0fdf4", text: "#14532d", accent: "#22c55e" },
  { name: "Matrix Light", bg: "#f0fdf4", text: "#1a3d1a", accent: "#16a34a" },
  { name: "Retro Light", bg: "#fffbeb", text: "#3d3820", accent: "#a89040" },
  { name: "Cyber Light", bg: "#f5f3ff", text: "#2d1a3d", accent: "#8b5cf6" },
  { name: "Neon Light", bg: "#fff0f7", text: "#3d1a2d", accent: "#ec4899" },
  { name: "Vapor Light", bg: "#f5f3ff", text: "#3d1a3d", accent: "#a855f7" },
  { name: "Synth Light", bg: "#f0f9ff", text: "#1a3a5a", accent: "#0ea5e9" },
  { name: "Outrun Light", bg: "#fff0f7", text: "#3d1a2d", accent: "#ec4899" },
  { name: "Blade Light", bg: "#f8fafc", text: "#1e293b", accent: "#6366f1" },
  { name: "Tron Light", bg: "#f0f9ff", text: "#0c4a6e", accent: "#0ea5e9" },
  { name: "Coffee Light", bg: "#faf5f0", text: "#3d3020", accent: "#a07050" },
  { name: "Mocha Light", bg: "#fafaf8", text: "#3d3830", accent: "#a08060" },
  { name: "Latte", bg: "#faf5f0", text: "#3d3028", accent: "#a07050" },
  { name: "Cappuccino", bg: "#f5f0e8", text: "#3d3830", accent: "#907060" },
  { name: "Espresso", bg: "#f0e8e0", text: "#3d3028", accent: "#806050" },
  { name: "Americano", bg: "#faf8f5", text: "#3d3835", accent: "#706050" },
  { name: "Macchiato", bg: "#faf5f0", text: "#3d3028", accent: "#a07050" },
  { name: "Flat White", bg: "#faf8f5", text: "#3d3835", accent: "#908070" },
  { name: "Cortado", bg: "#f5f0e8", text: "#3d3830", accent: "#806850" },
  { name: "Affogato", bg: "#f0e8e0", text: "#3d3028", accent: "#705840" },
  { name: "Ristretto", bg: "#e8e0d8", text: "#3d3028", accent: "#605040" },
  { name: "Lungo", bg: "#f5f0e8", text: "#3d3830", accent: "#806850" },
  { name: "Doppio", bg: "#f0e8e0", text: "#3d3028", accent: "#705840" },
  { name: "Red Eye", bg: "#faf0e8", text: "#3d2820", accent: "#a05040" },
  { name: "Black Eye", bg: "#f0e8e0", text: "#3d2820", accent: "#504030" },
  { name: "Dead Eye", bg: "#e8e0d8", text: "#3d2820", accent: "#403830" },
];

// Wacky / Crazy themes (엽기 모드)
export const WACKY_STYLES: StyleTheme[] = [
  // Neon crazy combos
  { name: "Toxic Waste", bg: "#39ff14", text: "#000000", accent: "#ff00ff" },
  { name: "Barbie Nightmare", bg: "#ff1493", text: "#ffffff", accent: "#00ffff" },
  { name: "LSD Trip", bg: "#ff00ff", text: "#00ff00", accent: "#ffff00" },
  { name: "Rave Party", bg: "#000000", text: "#ff00ff", accent: "#00ffff" },
  { name: "Disco Fever", bg: "#ff0080", text: "#ffff00", accent: "#00ff80" },
  { name: "Acid Rain", bg: "#00ff41", text: "#1a0f2e", accent: "#ff0080" },
  { name: "Electric Shock", bg: "#ffff00", text: "#0000ff", accent: "#ff0000" },
  { name: "Radioactive", bg: "#7fff00", text: "#1a0f00", accent: "#ff4500" },
  { name: "Plasma Burst", bg: "#ff4500", text: "#00ffff", accent: "#ffff00" },
  { name: "Gamma Ray", bg: "#00ffff", text: "#ff00ff", accent: "#ffff00" },
  
  // Eye-burning contrasts
  { name: "Highlighter", bg: "#ffff00", text: "#ff00ff", accent: "#00ffff" },
  { name: "Caution Tape", bg: "#000000", text: "#ffff00", accent: "#000000" },
  { name: "Construction Site", bg: "#ff6600", text: "#000000", accent: "#ffffff" },
  { name: "Traffic Cone", bg: "#ff4500", text: "#ffffff", accent: "#ffffff" },
  { name: "Fire Alarm", bg: "#ff0000", text: "#ffff00", accent: "#ffffff" },
  { name: "Emergency Exit", bg: "#00ff00", text: "#000000", accent: "#ffffff" },
  { name: "Police Lights", bg: "#0000ff", text: "#ff0000", accent: "#ffffff" },
  { name: "Ambulance", bg: "#ffffff", text: "#ff0000", accent: "#0000ff" },
  { name: "Fire Truck", bg: "#ff0000", text: "#ffffff", accent: "#ffff00" },
  { name: "Taxi Cab", bg: "#ffff00", text: "#000000", accent: "#ff6600" },
  
  // Food madness
  { name: "Ketchup & Mustard", bg: "#ff0000", text: "#ffff00", accent: "#ffffff" },
  { name: "Wasabi Bomb", bg: "#7fff00", text: "#8b0000", accent: "#ffffff" },
  { name: "Sriracha", bg: "#ff4500", text: "#006400", accent: "#ffffff" },
  { name: "Pickle Juice", bg: "#556b2f", text: "#ffff00", accent: "#ffffff" },
  { name: "Cotton Candy", bg: "#ffb6c1", text: "#00ffff", accent: "#ff69b4" },
  { name: "Bubblegum", bg: "#ff69b4", text: "#00ff00", accent: "#ffff00" },
  { name: "Candy Crush", bg: "#ff1493", text: "#00ffff", accent: "#ffff00" },
  { name: "Donut Sprinkles", bg: "#ff69b4", text: "#ffffff", accent: "#00ff00" },
  { name: "Pizza Grease", bg: "#ff8c00", text: "#8b0000", accent: "#ffff00" },
  { name: "Burrito Supreme", bg: "#8b4513", text: "#ffff00", accent: "#ff4500" },
  { name: "Taco Tuesday", bg: "#ffd700", text: "#ff4500", accent: "#228b22" },
  { name: "Ramen Broth", bg: "#daa520", text: "#8b0000", accent: "#228b22" },
  { name: "Kimchi Stain", bg: "#dc143c", text: "#ffff00", accent: "#228b22" },
  { name: "Moldy Bread", bg: "#556b2f", text: "#f5deb3", accent: "#8b4513" },
  { name: "Rotten Banana", bg: "#9acd32", text: "#654321", accent: "#000000" },
  { name: "Expired Milk", bg: "#f5f5dc", text: "#2f4f4f", accent: "#808080" },
  
  // Nature gone wrong
  { name: "Swamp Thing", bg: "#2f4f4f", text: "#9acd32", accent: "#8b4513" },
  { name: "Mossy Rock", bg: "#556b2f", text: "#f5deb3", accent: "#8b7355" },
  { name: "Dead Forest", bg: "#4a3728", text: "#8fbc8f", accent: "#654321" },
  { name: "Volcanic Ash", bg: "#2f2f2f", text: "#ff4500", accent: "#ffff00" },
  { name: "Lava Flow", bg: "#ff4500", text: "#000000", accent: "#ffff00" },
  { name: "Aurora Borealis", bg: "#191970", text: "#00ff7f", accent: "#ff00ff" },
  { name: "Deep Ocean", bg: "#000080", text: "#00ffff", accent: "#ff00ff" },
  { name: "Jellyfish", bg: "#4b0082", text: "#ff00ff", accent: "#00ffff" },
  { name: "Coral Reef", bg: "#ff7f50", text: "#00ffff", accent: "#ffff00" },
  { name: "Toxic Algae", bg: "#00ff00", text: "#8b008b", accent: "#ffff00" },
  
  // Retro gaming
  { name: "Game Boy", bg: "#8bac0f", text: "#0f380f", accent: "#306230" },
  { name: "Virtual Boy", bg: "#ff0000", text: "#000000", accent: "#ff0000" },
  { name: "Sega Genesis", bg: "#000000", text: "#00ff00", accent: "#ff0000" },
  { name: "SNES Purple", bg: "#800080", text: "#d3d3d3", accent: "#808080" },
  { name: "PlayStation Grey", bg: "#c0c0c0", text: "#000000", accent: "#ff0000" },
  { name: "Xbox Green", bg: "#00ff00", text: "#000000", accent: "#ffffff" },
  { name: "Atari Wood", bg: "#8b4513", text: "#ffa500", accent: "#000000" },
  { name: "Commodore 64", bg: "#4040ff", text: "#ffffff", accent: "#ff0000" },
  { name: "ZX Spectrum", bg: "#000000", text: "#00ff00", accent: "#ff0000" },
  { name: "Amiga Boing", bg: "#ff0000", text: "#ffffff", accent: "#0000ff" },
  
  // Meme culture
  { name: "Doge", bg: "#f4a460", text: "#8b4513", accent: "#ffffff" },
  { name: "Nyan Cat", bg: "#ff69b4", text: "#00ffff", accent: "#ffff00" },
  { name: "Pepe Green", bg: "#4a6741", text: "#ffffff", accent: "#ff0000" },
  { name: "Troll Face", bg: "#000000", text: "#ffffff", accent: "#ff0000" },
  { name: "Wojak Pink", bg: "#ff69b4", text: "#000000", accent: "#ffffff" },
  { name: "Chad Thunder", bg: "#1e90ff", text: "#ffffff", accent: "#ffd700" },
  { name: "Virgin Blue", bg: "#87ceeb", text: "#000000", accent: "#ffffff" },
  { name: "Galaxy Brain", bg: "#4b0082", text: "#ff00ff", accent: "#00ffff" },
  { name: "Stonks Green", bg: "#00ff00", text: "#000000", accent: "#ffffff" },
  { name: "Not Stonks Red", bg: "#ff0000", text: "#ffffff", accent: "#000000" },
  
  // Random absurd
  { name: "Unicorn Vomit", bg: "#ff00ff", text: "#00ffff", accent: "#ffff00" },
  { name: "Clown Fiesta", bg: "#ff0000", text: "#ffff00", accent: "#0000ff" },
  { name: "Disco Vomit", bg: "#00ffff", text: "#ff00ff", accent: "#ffff00" },
  { name: "Rainbow Diarrhea", bg: "#ff0000", text: "#00ff00", accent: "#0000ff" },
  { name: "Glitter Bomb", bg: "#ff69b4", text: "#ffffff", accent: "#ffd700" },
  { name: "Confetti Explosion", bg: "#ffff00", text: "#ff00ff", accent: "#00ffff" },
  { name: "Sparkle Motion", bg: "#ff1493", text: "#00ffff", accent: "#ffff00" },
  { name: "Glitch Art", bg: "#000000", text: "#00ff00", accent: "#ff0000" },
  { name: "VHS Tracking", bg: "#1a1a1a", text: "#00ffff", accent: "#ff00ff" },
  { name: "Dead Pixel", bg: "#000000", text: "#ff0000", accent: "#ffffff" },
  { name: "Blue Screen", bg: "#0000aa", text: "#ffffff", accent: "#aaaaaa" },
  { name: "Kernel Panic", bg: "#000000", text: "#ffffff", accent: "#ff0000" },
  { name: "Segfault", bg: "#8b0000", text: "#ffff00", accent: "#000000" },
  { name: "Stack Overflow", bg: "#f48024", text: "#ffffff", accent: "#bcbbbb" },
  { name: "404 Not Found", bg: "#ffffff", text: "#000000", accent: "#ff0000" },
  { name: "500 Error", bg: "#ff0000", text: "#ffffff", accent: "#000000" },
  { name: "Loading Screen", bg: "#000000", text: "#00ff00", accent: "#ffffff" },
  { name: "Buffering", bg: "#1a1a1a", text: "#ffffff", accent: "#808080" },
  { name: "Connection Lost", bg: "#2f2f2f", text: "#ff0000", accent: "#808080" },
  { name: "Ping Timeout", bg: "#000000", text: "#ffff00", accent: "#ff0000" },
  
  // More eye pain
  { name: "Laser Pointer", bg: "#ff0000", text: "#ffffff", accent: "#ff0000" },
  { name: "Black Light", bg: "#4b0082", text: "#ff00ff", accent: "#00ff00" },
  { name: "Strobe Light", bg: "#ffffff", text: "#000000", accent: "#ff0000" },
  { name: "Flashbang", bg: "#ffffff", text: "#ffff00", accent: "#ff0000" },
  { name: "Night Vision", bg: "#00ff00", text: "#000000", accent: "#ffffff" },
  { name: "Thermal Vision", bg: "#ff0000", text: "#ffff00", accent: "#ffffff" },
  { name: "X-Ray", bg: "#000000", text: "#00ffff", accent: "#ffffff" },
  { name: "Infrared", bg: "#8b0000", text: "#ff0000", accent: "#ffff00" },
  { name: "Ultraviolet", bg: "#4b0082", text: "#9400d3", accent: "#ff00ff" },
  { name: "Microwave", bg: "#2f2f2f", text: "#00ff00", accent: "#ff0000" },
  
  // Office supplies gone wild
  { name: "Post-it Yellow", bg: "#ffff00", text: "#000000", accent: "#ff0000" },
  { name: "Sharpie Permanent", bg: "#000000", text: "#4b0082", accent: "#ffffff" },
  { name: "Whiteboard Marker", bg: "#2f4f4f", text: "#00ff00", accent: "#ff0000" },
  { name: "Highlighter Pink", bg: "#ff69b4", text: "#000000", accent: "#ffff00" },
  { name: "Stapler Red", bg: "#8b0000", text: "#c0c0c0", accent: "#000000" },
  { name: "Paper Cut", bg: "#ffffff", text: "#ff0000", accent: "#000000" },
  { name: "Coffee Stain", bg: "#f5deb3", text: "#8b4513", accent: "#654321" },
  { name: "Ink Blot", bg: "#000000", text: "#ffffff", accent: "#ff0000" },
  { name: "Correction Fluid", bg: "#ffffff", text: "#000000", accent: "#ff0000" },
  { name: "Binder Clip", bg: "#000000", text: "#c0c0c0", accent: "#ff0000" },
  
  // Fashion disasters
  { name: "Neon Spandex", bg: "#ff00ff", text: "#00ffff", accent: "#ffff00" },
  { name: "Leopard Print", bg: "#daa520", text: "#000000", accent: "#8b4513" },
  { name: "Zebra Stripes", bg: "#000000", text: "#ffffff", accent: "#000000" },
  { name: "Tiger Print", bg: "#ff8c00", text: "#000000", accent: "#ffffff" },
  { name: "Cow Print", bg: "#ffffff", text: "#000000", accent: "#ff69b4" },
  { name: "Dalmatian", bg: "#ffffff", text: "#000000", accent: "#ff0000" },
  { name: "Plaid Nightmare", bg: "#ff0000", text: "#00ff00", accent: "#0000ff" },
  { name: "Paisley Fever", bg: "#ff69b4", text: "#00ffff", accent: "#ffff00" },
  { name: "Tie Dye", bg: "#ff00ff", text: "#00ff00", accent: "#ffff00" },
  { name: "Camouflage", bg: "#556b2f", text: "#8fbc8f", accent: "#654321" },
  
  // Final boss
  { name: "Maximum Overdrive", bg: "#ff0000", text: "#ffff00", accent: "#00ff00" },
  { name: "Turbo Mode", bg: "#00ffff", text: "#ff00ff", accent: "#ffff00" },
  { name: "God Mode", bg: "#ffd700", text: "#ffffff", accent: "#ff0000" },
  { name: "Cheat Code", bg: "#00ff00", text: "#000000", accent: "#ffffff" },
  { name: "Debug Mode", bg: "#ff00ff", text: "#00ff00", accent: "#ffff00" },
  { name: "Demo Mode", bg: "#ffff00", text: "#000000", accent: "#ff0000" },
  { name: "Trial Version", bg: "#c0c0c0", text: "#000000", accent: "#ff0000" },
  { name: "Expired License", bg: "#ff0000", text: "#ffffff", accent: "#000000" },
  { name: "Update Required", bg: "#ffff00", text: "#000000", accent: "#ff0000" },
  { name: "Blue Screen of Death", bg: "#0000aa", text: "#ffffff", accent: "#aaaaaa" },
  { name: "Clippy", bg: "#ffff00", text: "#000000", accent: "#c0c0c0" },
  { name: "Windows 95", bg: "#008080", text: "#000000", accent: "#c0c0c0" },
  { name: "Y2K Bug", bg: "#ff0000", text: "#ffff00", accent: "#000000" },
  { name: "Millennium", bg: "#ffd700", text: "#000000", accent: "#ffffff" },
  { name: "Apocalypse", bg: "#8b0000", text: "#ff4500", accent: "#ffff00" },
  { name: "Zombie", bg: "#2f4f4f", text: "#9acd32", accent: "#8b0000" },
  { name: "Vampire", bg: "#4b0082", text: "#ff0000", accent: "#ffffff" },
  { name: "Werewolf", bg: "#8b4513", text: "#ffd700", accent: "#c0c0c0" },
  { name: "Frankenstein", bg: "#228b22", text: "#8b0000", accent: "#ffff00" },
  { name: "Dracula", bg: "#800000", text: "#ffffff", accent: "#ff0000" },
];

// Combined STYLES for backward compatibility
export const STYLES: StyleTheme[] = [...DARK_STYLES, ...LIGHT_STYLES, ...WACKY_STYLES];

// Imported (Warp) / user-defined themes carry a full ANSI palette on top of the
// 3-color StyleTheme. They are addressed by styleIndex >= STYLES.length so the
// existing index-based persistence keeps working.
export type TerminalStyle = StyleTheme & {
  ansi?: string[];
  cursor?: string;
  selectionBg?: string;
};

/** Resolve a styleIndex against built-in STYLES plus custom themes. */
export function getStyleAt(index: number | undefined, customThemes?: TerminalStyle[]): TerminalStyle {
  const i = typeof index === 'number' && Number.isFinite(index) ? index : 0;
  if (i >= 0 && i < STYLES.length) return STYLES[i];
  const ci = i - STYLES.length;
  if (customThemes && ci >= 0 && ci < customThemes.length) return customThemes[ci];
  return STYLES[0];
}

// Module-level registry so the dozens of `STYLES[i] || STYLES[0]` lookup sites can
// resolve custom themes without threading config through every component. App.tsx
// refreshes it whenever config.customThemes changes.
let customThemesRegistry: TerminalStyle[] = [];
export function setCustomThemes(themes: TerminalStyle[]) {
  customThemesRegistry = themes || [];
}
export function getCustomThemes(): TerminalStyle[] {
  return customThemesRegistry;
}
/** styleIndex → theme, resolving imported themes registered via setCustomThemes. */
export function styleAt(index: number | undefined): TerminalStyle {
  return getStyleAt(index, customThemesRegistry);
}
