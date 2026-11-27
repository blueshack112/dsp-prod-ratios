// Reads research progress out of a Dyson Sphere Program save file (.dsv)
//
// The save is not parsed in full. The tech states are stored as a dictionary:
//   int32 count, then `count` records of
//   { int32 techId, uint8 unlocked, int32 curLevel, int32 maxLevel, int64 hashUploaded, int64 hashNeeded, 8 bytes }
// The first two records are always tech 1 (Dyson Sphere Program) and 1001 (Electromagnetism),
// so the table is located by that shape. (Layout worked out from game version 0.10 saves)

const Magic = 'VFSAVE';
const RecordSize = 37;
const FirstTechs = [1, 1001];

// The table sits early in the file, well before the bulk factory data
const HeadSize = 8 * 1024 * 1024;


function findTechStates(buffer) {
	const bytes = new Uint8Array(buffer);
	const view = new DataView(buffer);
	const end = bytes.length - RecordSize * 2;

	for(let offset = 4; offset < end; ++offset)
	{
		if(bytes[offset] !== FirstTechs[0]) continue;
		if(view.getInt32(offset, true) !== FirstTechs[0]) continue;
		if(view.getInt32(offset + RecordSize, true) !== FirstTechs[1]) continue;

		const count = view.getInt32(offset - 4, true);
		if(count < 50 || count > 10000) continue;
		if(offset + count * RecordSize > bytes.length) continue;

		const states = [];
		let valid = true;
		for(let iter = 0; iter < count && valid; ++iter)
		{
			const at = offset + iter * RecordSize;
			const id = view.getInt32(at, true);
			const unlocked = bytes[at + 4];
			if(id < 0 || id > 100000 || unlocked > 1) valid = false;
			else states.push({ id, unlocked: unlocked === 1 });
		}

		if(valid) return states;
	}

	return null;
}

// Returns the tech states found in the save file, as [{ id, unlocked }, …]
export async function readTechStates(file) {
	const head = await file.slice(0, HeadSize).arrayBuffer();

	const magic = String.fromCharCode(...new Uint8Array(head, 0, Math.min(Magic.length, head.byteLength)));
	if(magic !== Magic) throw new Error(`${file.name} is not a Dyson Sphere Program save file`);

	let states = findTechStates(head);
	if(!states && file.size > HeadSize) states = findTechStates(await file.arrayBuffer());
	if(!states) throw new Error(`Could not find the research data in ${file.name}, the save format may have changed`);

	return states;
}



// Remembering the save folder between visits (File System Access API, Chromium only)

export const canPickFolder = 'showDirectoryPicker' in globalThis;

const DatabaseName = 'save-sync';
const StoreName = 'handles';
const HandleKey = 'save-folder';

function withStore(mode, callback) {
	return new Promise((resolve, reject) => {
		const open = indexedDB.open(DatabaseName, 1);
		open.onupgradeneeded = () => open.result.createObjectStore(StoreName);
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const database = open.result;
			try {
				const transaction = database.transaction(StoreName, mode);
				const request = callback(transaction.objectStore(StoreName));
				transaction.oncomplete = () => { database.close(); resolve(request.result); };
				transaction.onerror = () => { database.close(); reject(transaction.error); };
				transaction.onabort = () => { database.close(); reject(transaction.error); };
			} catch(error) {
				database.close();
				reject(error);
			}
		};
	});
}

export async function getSaveFolder() {
	if(!canPickFolder) return null;
	try { return await withStore('readonly', store => store.get(HandleKey)) || null; }
	catch(error) { return null; }
}

export async function forgetSaveFolder() {
	try { await withStore('readwrite', store => store.delete(HandleKey)); }
	catch(error) {}
}

// Must be called from a user gesture
export async function pickSaveFolder() {
	const folder = await showDirectoryPicker({ id: 'dsp-save', mode: 'read', startIn: 'documents' });
	try { await withStore('readwrite', store => store.put(folder, HandleKey)); }
	catch(error) {}
	return folder;
}

// Must be called from a user gesture, as the browser may need to ask for permission again
export async function latestAutosave(folder) {
	const options = { mode: 'read' };
	if(await folder.queryPermission(options) !== 'granted' && await folder.requestPermission(options) !== 'granted')
		throw new Error('Permission to read the save folder was not granted');

	let latest = null;
	for await (const entry of folder.values())
	{
		if(entry.kind !== 'file' || !/^_autosave_\d+\.dsv$/i.test(entry.name)) continue;
		const file = await entry.getFile();
		if(!latest || file.lastModified > latest.lastModified) latest = file;
	}

	if(!latest) throw new Error(`No autosaves found in "${folder.name}", pick the game's Save folder`);
	return latest;
}
