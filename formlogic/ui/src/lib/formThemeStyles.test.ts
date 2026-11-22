import { describe, expect, it } from 'vitest';
import {
  FORM_STYLE_PRESETS,
  getFormThemeTokens,
  resolveFormFontStack,
  suggestedPresetIdForTemplate,
} from './formThemeStyles';

describe('formThemeStyles', () => {
  it('resolves legacy unloaded Inter and empty font names to loaded DM Sans stack instead of browser serif', () => {
    expect(resolveFormFontStack('Inter')).toContain("'DM Sans'");
    expect(resolveFormFontStack('')).toContain("'DM Sans'");
    expect(resolveFormFontStack(undefined)).toContain("'DM Sans'");
    expect(resolveFormFontStack('Georgia')).toContain('Georgia');
    expect(resolveFormFontStack('monospace')).toContain('monospace');
  });

  it('applies borderRadius, surfaceStyle, inputStyle, density, and backgroundPattern tokens faithfully', () => {
    const clinical = FORM_STYLE_PRESETS.find((p) => p.id === 'clinical')!;
    const tokens = getFormThemeTokens(clinical.theme);
    expect(tokens.surfaceStyle).toBe('paper');
    expect(tokens.inputStyle).toBe('outlined');
    expect(tokens.headerStyle).toBe('accent_bar');
    expect(tokens.density).toBe('compact');
    expect(tokens.controlRadiusClass).toBe('rounded-md');
    expect(tokens.sheetClass).toContain('border');
    expect(tokens.sheetStyle.backgroundColor).toBe('#ffffff');

    const midnight = FORM_STYLE_PRESETS.find((p) => p.id === 'midnight')!;
    const darkTokens = getFormThemeTokens(midnight.theme);
    expect(darkTokens.isPageDark).toBe(true);
    expect(darkTokens.isSurfaceDark).toBe(true);
    expect(darkTokens.pageStyle.backgroundImage).toContain('radial-gradient');
    expect(darkTokens.selectOptionStyle.backgroundColor).toBe('#1e293b');
    expect(darkTokens.selectOptionStyle.color).toBe('#f8fafc');

    const sharp = getFormThemeTokens({
      primaryColor: '#000000',
      backgroundColor: '#ffffff',
      textColor: '#111111',
      fontFamily: 'DM Sans',
      borderRadius: 'none',
      inputStyle: 'underline',
    });
    expect(sharp.controlRadiusClass).toBe('rounded-none');
    expect(sharp.cardRadiusClass).toBe('rounded-none');
    expect(sharp.inputClass).toContain('border-b-2');
  });

  it('guarantees readable text color when a dark page uses a white paper sheet', () => {
    const tokens = getFormThemeTokens({
      primaryColor: '#4f46e5',
      backgroundColor: '#0f172a',
      textColor: '#f8fafc',
      cardColor: '#ffffff',
      fontFamily: 'DM Sans',
      borderRadius: 'medium',
      surfaceStyle: 'paper',
    });
    expect(tokens.isPageDark).toBe(true);
    expect(tokens.isSurfaceDark).toBe(false);
    expect(tokens.surfaceTextColor).toBe('#111827');
  });

  it('suggests Clinical Paper for healthcare templates and Modern Clean by default', () => {
    expect(suggestedPresetIdForTemplate('healthcare')).toBe('clinical');
    expect(suggestedPresetIdForTemplate('events')).toBe('elevated');
    expect(suggestedPresetIdForTemplate(undefined)).toBe('modern');
  });
});
