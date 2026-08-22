// Self-check for the temperature picker. Run:
//   npx --prefix server tsx client/src/lib/temperature.check.ts
// (no test runner in this project — plain asserts, one file, runnable anywhere)
import { temperatureNow, temperatureValues, isFurnaceRef } from './temperature';

const eq = (what: string, got: unknown, want: unknown): void => {
  const [a, b] = [JSON.stringify(got), JSON.stringify(want)];
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
};

// A furnace's work zones are its temperature; the recipe is not.
const furnace = { T1: 615, T2: 625, T3: 620, T4: 620, mainTempSet_c: 620, loop1_hiDev: 80, loop1_loWarn: -30 };
eq('furnace zones', temperatureValues(furnace, 'QUENCHINGFURNACE02'), [615, 625, 620, 620]);
eq('furnace mean', temperatureNow(furnace, 'QUENCHINGFURNACE02'), 620);

// The plant reads `mainTempSet_c` as this furnace's temperature, so it is shown
// when nothing else is — but ONLY then: a real thermocouple must never be
// averaged with it, or four live zones get dragged toward a constant.
eq('main temp is the fallback', temperatureNow({ mainTempSet_c: 620 }, 'QUENCHINGFURNACE02'), 620);
eq('measured zones beat the fallback', temperatureNow({ T1: 610, T2: 590, mainTempSet_c: 620 }, 'QUENCHINGFURNACE02'), 600);
eq('a named temp beats the fallback', temperatureNow({ CV_TEMP: 300, mainTempSet_c: 620 }, 'QUENCHINGFURNACE02'), 300);
// Everything else that merely LOOKS like a temperature stays out.
eq('SV_TEMP is a set value', temperatureNow({ SV_TEMP: 150 }, 'SPG04'), null);
eq('alarm flag is not a temperature', temperatureNow({ OIL_TEMP_ALARM: 0 }, 'SPG08'), null);

// A named process temperature is read on any machine…
eq('CV_TEMP on a non-furnace', temperatureNow({ CV_TEMP: 27, SV_TEMP: 68 }, 'SPG02'), 27);
// …but T-numbers are S7 TIMERS unless the machine is a furnace.
eq('T3 on a press is a timer', temperatureNow({ T3: 45 }, 'HYDRAULICPRESS02'), null);
eq('T3 on a furnace is a zone', temperatureNow({ T3: 45 }, 'QUENCHINGFURNACE02'), 45);

// Dead channels never drag the mean.
eq('fault sentinel dropped', temperatureNow({ T1: 620, T2: -32768 }, 'QUENCHINGFURNACE02'), 620);
eq('null zone dropped', temperatureNow({ T1: 620, T2: null }, 'QUENCHINGFURNACE02'), 620);
eq('all-null furnace reports nothing', temperatureNow({ T1: null, T2: null }, 'QUENCHINGFURNACE02'), null);

eq('isFurnaceRef', [isFurnaceRef('QUENCHINGFURNACE02'), isFurnaceRef('SPG04'), isFurnaceRef(null)], [true, false, false]);

console.log('temperature.check: all assertions passed');
