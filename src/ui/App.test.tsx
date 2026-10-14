import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('App', () => {
  it('renders app title', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Тренажёр отбора' })).toBeTruthy();
  });

  // Регрессия: без cleanup между тестами DOM накапливается и getByRole находит два заголовка.
  it('starts each test with a clean DOM', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Тренажёр отбора' })).toBeTruthy();
  });
});
