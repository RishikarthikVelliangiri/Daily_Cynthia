import { loadGameDataFromDisk } from '../src/data';
import { romShowdownDiffs } from '../src/battle/showdown';
const d = romShowdownDiffs(await loadGameDataFromDisk());
console.log(d.join('\n'));
console.log(d.length, 'differences');
