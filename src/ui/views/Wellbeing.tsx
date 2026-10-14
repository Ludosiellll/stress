import { useState } from 'react';
import type { WellbeingRow } from '../../data/rows';

export type WellbeingInput = Omit<WellbeingRow, 'id' | 'date'>;

export interface WellbeingProps {
  busy: boolean;
  onSubmit: (w: WellbeingInput | null) => void;
}

const MOODS = [1, 2, 3, 4, 5] as const;
type Mood = (typeof MOODS)[number];

/** Hours 0–14 in steps of 0.5; a comma is accepted as the decimal sign. Null when the field is not valid. */
function parseSleep(raw: string): number | null {
  const s = raw.trim().replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 14 && Number.isInteger(n * 2) ? n : null;
}

/** After a training session: sleep, caffeine and mood, or «Пропустить». */
export default function Wellbeing({ busy, onSubmit }: WellbeingProps) {
  const [sleep, setSleep] = useState('');
  const [caffeine, setCaffeine] = useState(false);
  const [mood, setMood] = useState<Mood | null>(null);
  const sleepH = parseSleep(sleep);
  const ready = sleepH !== null && mood !== null;

  return (
    <form
      className="screen-center wellbeing"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || sleepH === null || mood === null) return;
        onSubmit({ sleepH, caffeine, mood });
      }}
    >
      <h2>Самочувствие</h2>
      <label className="field">
        Сон прошлой ночью, часов
        <input
          type="number"
          min="0"
          max="14"
          step="0.5"
          autoFocus
          value={sleep}
          onChange={(e) => {
            setSleep(e.target.value);
          }}
        />
      </label>
      {sleep !== '' && sleepH === null && <p className="muted">От 0 до 14 часов, с шагом 0,5.</p>}
      <fieldset>
        <legend>Кофеин сегодня</legend>
        <label className="choice-inline">
          <input type="radio" name="caffeine" checked={caffeine} onChange={() => { setCaffeine(true); }} /> Да
        </label>
        <label className="choice-inline">
          <input type="radio" name="caffeine" checked={!caffeine} onChange={() => { setCaffeine(false); }} /> Нет
        </label>
      </fieldset>
      <fieldset>
        <legend>Самочувствие: 1 — плохо, 5 — отлично</legend>
        {MOODS.map((m) => (
          <label key={m} className="choice-inline">
            <input type="radio" name="mood" checked={mood === m} onChange={() => { setMood(m); }} /> {m}
          </label>
        ))}
      </fieldset>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || !ready}>
          Сохранить
        </button>
        <button type="button" disabled={busy} onClick={() => { onSubmit(null); }}>
          Пропустить
        </button>
      </div>
    </form>
  );
}
