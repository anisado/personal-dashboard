const FIELD_RANGES = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 6 }
];

function parseField(field, { name, min, max }) {
  const values = new Set();
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in ${name}: "${part}"`);
    let start = min;
    let end = max;
    if (range !== '*') {
      const bounds = range.split('-').map(Number);
      if (bounds.some((value) => !Number.isInteger(value))) {
        throw new Error(`Invalid ${name} value: "${part}"`);
      }
      start = bounds[0];
      end = bounds.length > 1 ? bounds[1] : bounds[0];
      if (stepRaw !== undefined && bounds.length === 1) end = max;
    }
    if (start < min || end > max || start > end) throw new Error(`${name} out of range: "${part}"`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression) {
  const fields = expression.split(/\s+/).filter(Boolean);
  if (fields.length !== 5) throw new Error('Expected 5 fields: minute hour day-of-month month day-of-week');
  return fields.map((field, index) => parseField(field, FIELD_RANGES[index]));
}

export function nextCronRuns(expression, count = 5) {
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parseCron(expression);
  const runs = [];
  const cursor = new Date();
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit && runs.length < count; i += 1) {
    if (
      minutes.has(cursor.getMinutes()) &&
      hours.has(cursor.getHours()) &&
      daysOfMonth.has(cursor.getDate()) &&
      months.has(cursor.getMonth() + 1) &&
      daysOfWeek.has(cursor.getDay())
    ) {
      runs.push(new Date(cursor));
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return runs;
}
