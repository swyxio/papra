import { defineConfig, presetIcons, presetWind4, transformerVariantGroup } from 'unocss';

export default defineConfig({
  presets: [presetWind4(), presetIcons()],
  transformers: [transformerVariantGroup()],
  theme: {
    font: { sans: '"DM Sans", ui-sans-serif, system-ui, sans-serif' },
    colors: {
      'background': '#fbf9f7',
      'foreground': '#1c1917',
      'surface': '#ffffff',
      'primary': '#ff5724',
      'primary-foreground': '#ffffff',
      'secondary': '#eeece8',
      'border': '#e3e1de',
      'muted': '#6b6965',
    },
  },
  shortcuts: {},
});
