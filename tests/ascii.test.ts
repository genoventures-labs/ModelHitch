import { describe, expect, it, vi } from 'vitest';
import { ASCII_LOGO, printAsciiLogo } from '../src/index.js';

describe('ASCII logo', () => {
  it('contains the braille chain-link mark and the wordmark', () => {
    expect(ASCII_LOGO).toContain('⣠'); // braille block in the mark
    expect(ASCII_LOGO).toContain('\\/    \\/\\___/'); // ASCII wordmark ("hitch")
    expect(ASCII_LOGO.split('\n').length).toBeGreaterThan(15);
  });

  it('printAsciiLogo writes the logo plus a blank line', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    printAsciiLogo();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![0]).toBe(ASCII_LOGO);
    expect(spy.mock.calls[1]![0]).toBe('');
    spy.mockRestore();
  });
});
