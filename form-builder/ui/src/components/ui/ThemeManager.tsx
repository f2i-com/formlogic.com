import { useEffect } from 'react';
import { useUIStore } from '../../stores/uiStore';

// Tailwind color palettes (50-950)
const colorPalettes: Record<string, Record<number, string>> = {
    indigo: {
        50: '238 242 255',
        100: '224 231 255',
        200: '199 210 254',
        300: '165 180 252',
        400: '129 140 248',
        500: '99 102 241',
        600: '79 70 229',
        700: '67 56 202',
        800: '55 48 163',
        900: '49 46 129',
        950: '30 27 75',
    },
    lime: {
        50: '247 254 231',
        100: '236 252 203',
        200: '217 249 157',
        300: '190 242 100',
        400: '163 230 53',
        500: '132 204 22',
        600: '101 163 13',
        700: '77 124 15',
        800: '63 98 18',
        900: '54 83 20',
        950: '26 46 5',
    },
    rose: {
        50: '255 241 242',
        100: '255 228 230',
        200: '254 205 211',
        300: '253 164 175',
        400: '251 113 133',
        500: '244 63 94',
        600: '225 29 72',
        700: '190 18 60',
        800: '159 18 57',
        900: '136 19 55',
        950: '76 5 25',
    },
    orange: {
        50: '255 247 237',
        100: '255 237 213',
        200: '254 215 170',
        300: '253 186 116',
        400: '251 146 60',
        500: '249 115 22',
        600: '234 88 12',
        700: '194 65 12',
        800: '154 52 18',
        900: '124 45 18',
        950: '67 20 7',
    },
    cyan: {
        50: '236 254 255',
        100: '207 250 254',
        200: '165 243 252',
        300: '103 232 249',
        400: '34 211 238',
        500: '6 182 212',
        600: '8 145 178',
        700: '14 116 144',
        800: '21 94 117',
        900: '22 78 99',
        950: '8 51 68',
    },
    violet: {
        50: '245 243 255',
        100: '237 233 254',
        200: '221 214 254',
        300: '196 181 253',
        400: '167 139 250',
        500: '139 92 246',
        600: '124 58 237',
        700: '109 40 217',
        800: '91 33 182',
        900: '76 29 149',
        950: '46 16 101',
    },
};

export function ThemeManager() {
    const { theme, themeColor } = useUIStore();

    useEffect(() => {
        const root = document.documentElement;
        const palette = colorPalettes[themeColor] || colorPalettes.indigo;

        // Apply CSS variables for the selected color palette
        // We only apply this if we are in Dark Mode, OR if we want custom colors in Light Mode too.
        // The user requirement was "change the accent colour of the app too", implying global change.
        // However, our Visual Redesign established specific defaults (Indigo for Light, Lime for Dark).
        // To respect the user's specific choice, we will override the variables regardless of mode,
        // essentially allowing them to replace the "default" Indigo or Lime.

        // BUT, we should handle the default state intelligently.
        // If the user picked 'lime', they want lime.

        Object.entries(palette).forEach(([shade, value]) => {
            root.style.setProperty(`--primary-${shade}`, value);
        });

    }, [themeColor, theme]);

    return null;
}
