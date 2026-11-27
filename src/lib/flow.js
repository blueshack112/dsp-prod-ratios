// Turns the solver's recipe tree into a production flow graph:
// one node per recipe (merged wherever the tree repeats it), one node per gathered resource,
// and one link per item flowing between them. Also lays the graph out left to right.

import {
	Items,
	AssemblerProductionSpeed,
	SmelterProductionSpeed,
	ChemicalProductionSpeed,
	FractionationProductionSpeed,
	Proliferator,
} from './data.js';
import state from '../state.js';


// Which building a recipe is made in, following the preferred buildings where there is a choice
export function buildingForRecipe(recipe) {
	switch(recipe.type) {
		case 'ASSEMBLE': return state.preferred.assembler.value;
		case 'SMELT': return state.preferred.smelter.value;
		case 'CHEMICAL': return state.preferred.chemical.value;
		case 'RESEARCH': return 2901; // Matrix Lab
		case 'REFINE': return 2308; // Oil Refinery
		case 'PARTICLE': return 2310; // Miniature Particle Collider
		case 'FRACTIONATE': return 2314; // Fractionator
	}
}


// Which building gathers a raw resource, and how much one of them (or one vein under it) yields per minute.
// Yields are the base values without mining speed upgrades; where it depends on the planet there is none.
const VeinItems = new Set([1001, 1002, 1003, 1004, 1005, 1006, 1011, 1012, 1013, 1014, 1015, 1016, 1117]);
const PumpItems = new Set([1000, 1116]); // Water, Sulfuric Acid
const OrbitItems = new Set([1120, 1121]); // Hydrogen, Deuterium

export function buildingForResource(item) {
	if(VeinItems.has(item.id)) return { building: 2301 /* Mining Machine */, perVein: 30 };
	if(PumpItems.has(item.id)) return { building: 2306 /* Water Pump */, perBuilding: 50 };
	if(item.id === 1007) return { building: 2307 /* Oil Extractor */ };
	if(OrbitItems.has(item.id)) return { building: 2105 /* Orbital Collector */ };
	return null; // Gathered by hand or dropped by enemies
}


// Sorters, best first. The fastest one unlocked by the current research is the one to build with
const SorterItems = [2014, 2013, 2012, 2011];

// The sorter to use and how many items a minute one of them moves.
// Assumes the shortest reach (one grid cell) and no sorter stacking upgrades:
// a trip there and back takes twice the sorter's travel time, 60 ticks to the second
export function bestSorter() {
	const unlocked = state.itemsUnlockedSet.value;
	const id = SorterItems.find(id => unlocked.has(id)) || SorterItems[SorterItems.length - 1];
	const item = Items.find(item => item.id === id);
	const { stt, stackSize } = item._InserterDesc;
	const tripsPerMinute = 60 * 60 / (2 * stt / 10000);
	return { item, perMinute: tripsPerMinute * (stackSize || 1) };
}

// Sorters for one production step: every building needs enough of them on each input and each output
// to keep up with that building running flat out
export function sortersForNode(node, sorter) {
	if(node.kind !== 'recipe' || !(node.facilities > 0)) return 0;
	const buildings = Math.ceil(+node.facilities.toFixed(6));
	const perBuilding = rate => Math.max(1, Math.ceil(+(rate / node.facilities / sorter.perMinute).toFixed(6)));
	
	let each = node.locked.length;
	for(const link of node.inputs) each += perBuilding(link.rate);
	for(const output of node.outputs) each += perBuilding(output.rate);
	return buildings * each;
}


// Mirrors the maths of <SolveTree> in components/solver.jsx
export function buildFlow(root, throughput) {
	const nodes = new Map();
	const links = new Map();

	function getNode(key, create) {
		if(!nodes.has(key)) nodes.set(key, { key, inputs: [], ...create() });
		return nodes.get(key);
	}

	function addLink(from, to, item, rate) {
		const key = `${from}>${to}>${item}`;
		if(!links.has(key)) links.set(key, { key, from, to, item, rate: 0 });
		links.get(key).rate += rate;
	}

	function walk(solve, throughput, ingredient, parent, path) {
		if(!solve || path.length > 10) return;

		if('item' in solve)
		{
			if(!solve.item) return;
			const node = getNode(`item:${solve.item.id}`, () => ({ kind: 'source', item: solve.item, rate: 0 }));
			node.rate += throughput;
			if(parent) addLink(node.key, parent, solve.item.id, throughput);
			return;
		}

		const { recipe, children } = solve;
		if(path.includes(recipe)) return; // Recipes that feed themselves

		let modifier = 1.0;
		switch(recipe.type) {
			case 'ASSEMBLE': modifier = AssemblerProductionSpeed.get(state.preferred.assembler.value); break;
			case 'SMELT': modifier = SmelterProductionSpeed.get(state.preferred.smelter.value); break;
			case 'CHEMICAL': modifier = ChemicalProductionSpeed.get(state.preferred.chemical.value); break;
			case 'FRACTIONATE': modifier = FractionationProductionSpeed(state.research.value) / 60 / 60; break;
		}

		if(!ingredient) ingredient = recipe.results[0];
		const ingredientIndex = recipe.results.findIndex(result => result === ingredient);
		let ingredientsPerMinute = recipe.resultCounts[ingredientIndex] * (60/recipe.timeSpend*60);

		const proliferatorPoints = state.proliferatorPoints.value;
		const proliferatorType = state.proliferatorCustom.value.has(solve.id)? state.proliferatorCustom.value.get(solve.id) : state.proliferatorPreset.value.get(solve.id);
		if(proliferatorPoints)
		{
			const index = Proliferator.Ability.indexOf(proliferatorPoints);
			switch(proliferatorType)
			{
				case 'speedup': modifier *= Proliferator.ProductionSpeed[index]; break;
				case 'extra': ingredientsPerMinute *= Proliferator.ExtraProducts[index]; break;
			}
		}

		const facilities = throughput / ingredientsPerMinute / modifier;

		const node = getNode(`recipe:${recipe.id}`, () => ({
			kind: 'recipe',
			recipe,
			building: buildingForRecipe(recipe),
			facilities: 0,
			outputs: recipe.results.map(item => ({ item, rate: 0 })),
			locked: [],
		}));
		node.facilities += facilities;
		recipe.results.forEach((result, index) => {
			node.outputs[index].rate += throughput * (recipe.resultCounts[index] / recipe.resultCounts[ingredientIndex]);
		});
		if(parent) addLink(node.key, parent, ingredient, throughput);

		if(children) children.forEach((child, index) => {
			if(Array.isArray(child))
			{
				const item = Items.find(item => item.id === recipe.items[index]);
				const preferredAltRecipe = state.preferred[item.id]?.value;
				const hasMiningFrom = preferredAltRecipe === item.id && item.miningFrom;

				if(!hasMiningFrom && !state.recipesUnlockedSet.value.has(preferredAltRecipe))
				{
					if(!node.locked.includes(item.id)) node.locked.push(item.id);
					return;
				}

				let preferredChild = child.find(d => d.recipe?.id === preferredAltRecipe);
				if(!preferredChild && hasMiningFrom) preferredChild = child.find(d => d.item === item);
				child = preferredChild;
			}

			if(!child) return;

			const itemsPerMinute = recipe.itemCounts[index] * (60/recipe.timeSpend*60);
			walk(child, facilities * itemsPerMinute * modifier, recipe.items[index], node.key, [...path, recipe]);
		});
	}

	walk(root, throughput, null, null, []);

	addSplitters(nodes, links);
	
	const flow = { nodes: Array.from(nodes.values()), links: Array.from(links.values()), root: nodes.get(`recipe:${root.recipe?.id}`) };
	for(const link of flow.links) nodes.get(link.to).inputs.push(link);
	return flow;
}



// Wherever one output feeds several consumers, put splitters in between.
// A splitter has four ports, so one belt in leaves three out; more consumers than that chain a second splitter
// off the third output, and so on.
const SplitterOutputs = 3;

function addSplitters(nodes, links) {
	const groups = new Map();
	for(const link of links.values())
	{
		const key = `${link.from}>${link.item}`;
		if(!groups.has(key)) groups.set(key, []);
		groups.get(key).push(link);
	}
	
	for(const [groupKey, group] of groups)
	{
		if(group.length < 2) continue;
		
		const item = Items.find(item => item.id === group[0].item);
		const from = group[0].from;
		for(const link of group) links.delete(link.key);
		
		// Biggest consumers first, so the chain hands on ever smaller amounts
		let remaining = group.slice().sort((a, b) => b.rate - a.rate);
		let source = from;
		for(let index = 1; remaining.length; ++index)
		{
			const key = `splitter:${groupKey}:${index}`;
			const rate = remaining.reduce((sum, link) => sum + link.rate, 0);
			const direct = remaining.length > SplitterOutputs? remaining.slice(0, SplitterOutputs - 1) : remaining;
			remaining = remaining.slice(direct.length);
			
			const outputs = direct.map(link => ({ item: item.id, rate: link.rate, to: link.to }));
			if(remaining.length) outputs.push({ item: item.id, rate: remaining.reduce((sum, link) => sum + link.rate, 0), to: `splitter:${groupKey}:${index + 1}` });
			
			nodes.set(key, { key, kind: 'splitter', item, rate, outputs, inputs: [], locked: [] });
			links.set(`${source}>${key}`, { key: `${source}>${key}`, from: source, to: key, item: item.id, rate });
			for(const link of direct)
			{
				const out = `${key}>${link.to}`;
				links.set(out, { key: out, from: key, to: link.to, item: item.id, rate: link.rate });
			}
			source = key;
		}
	}
}

// The smallest whole-number ratio between amounts, such as [2, 1], or null when there is no tidy one
export function splitRatio(rates) {
	const smallest = Math.min(...rates);
	if(!(smallest > 0)) return null;
	for(let multiplier = 1; multiplier <= 12; ++multiplier)
	{
		const parts = rates.map(rate => rate / smallest * multiplier);
		if(parts.every(part => Math.abs(part - Math.round(part)) < 0.01)) return parts.map(Math.round);
	}
	return null;
}



// Layout

export const Metrics = {
	width: 320,
	header: 56,
	row: 30,
	padding: 10,
	columnGap: 130,
	rowGap: 26,
	margin: 60,
};

function nodeHeight(node) {
	const rows = node.kind === 'source'? 1 : Math.max(node.inputs.length + node.locked.length, node.outputs.length, 1);
	return Metrics.header + rows * Metrics.row + Metrics.padding;
}

// Positions every node and link, returns the size of the whole graph.
// `offsets` maps node keys to { x, y } nudges for cards that were dragged by hand
export function layoutFlow(flow, offsets) {
	const { nodes, links, root } = flow;
	const byKey = new Map(nodes.map(node => [node.key, node]));

	// Columns: the final product goes last, everything else as far from it as its longest chain
	for(const node of nodes) node.layer = 0;
	for(let pass = 0; pass < nodes.length; ++pass)
	{
		let changed = false;
		for(const link of links)
		{
			const from = byKey.get(link.from), to = byKey.get(link.to);
			if(from.layer < to.layer + 1) { from.layer = to.layer + 1; changed = true; }
		}
		if(!changed) break;
	}
	const layers = Math.max(...nodes.map(node => node.layer)) + 1;
	const columns = Array.from({ length: layers }, () => []);
	for(const node of nodes)
	{
		// Everything that is gathered lines up in the first column, however short its chain is
		if(node.kind === 'source') node.layer = layers - 1;
		node.column = layers - 1 - node.layer;
		node.height = nodeHeight(node);
		columns[node.column].push(node);
	}

	function stack() {
		const heights = columns.map(column => column.reduce((sum, node) => sum + node.height, 0) + (column.length - 1) * Metrics.rowGap);
		const tallest = Math.max(...heights);
		columns.forEach((column, index) => {
			let y = Metrics.margin + (tallest - heights[index]) / 2;
			for(const node of column)
			{
				node.x = Metrics.margin + index * (Metrics.width + Metrics.columnGap);
				node.y = y;
				y += node.height + Metrics.rowGap;
			}
		});
		return tallest;
	}

	// Order each column by where its neighbours sit, to keep links from crossing
	const centre = node => node.y + node.height / 2;
	const neighbours = new Map(nodes.map(node => [node, []]));
	for(const link of links)
	{
		neighbours.get(byKey.get(link.from)).push(byKey.get(link.to));
		neighbours.get(byKey.get(link.to)).push(byKey.get(link.from));
	}
	stack();
	for(let sweep = 0; sweep < 6; ++sweep)
	{
		const order = sweep % 2? columns : columns.slice().reverse();
		for(const column of order)
		{
			const weights = new Map(column.map(node => {
				const around = neighbours.get(node);
				return [node, around.length? around.reduce((sum, other) => sum + centre(other), 0) / around.length : centre(node)];
			}));
			column.sort((a, b) => weights.get(a) - weights.get(b));
			stack();
		}
	}
	const tallest = stack();
	
	if(offsets) for(const node of nodes)
	{
		const offset = offsets.get(node.key);
		if(offset) { node.x += offset.x; node.y += offset.y; }
	}

	// A splitter's outputs are listed in the order of where they lead, top to bottom
	for(const node of nodes)
		if(node.kind === 'splitter') node.outputs.sort((a, b) => centre(byKey.get(a.to)) - centre(byKey.get(b.to)));
	
	// Ports: inputs down the left of a node (ordered by where they come from), outputs down the right
	for(const node of nodes)
	{
		node.inputs.sort((a, b) => centre(byKey.get(a.from)) - centre(byKey.get(b.from)));
		node.inputs.forEach((link, index) => {
			link.x2 = node.x;
			link.y2 = node.y + Metrics.header + index * Metrics.row + Metrics.row / 2;
		});
	}
	for(const link of links)
	{
		const from = byKey.get(link.from);
		const index = from.kind === 'source'? 0 : Math.max(0, from.outputs.findIndex(output => output.item === link.item && (!output.to || output.to === link.to)));
		link.x1 = from.x + Metrics.width;
		link.y1 = from.y + Metrics.header + index * Metrics.row + Metrics.row / 2;
		const bend = Math.max(50, (link.x2 - link.x1) / 2);
		link.path = `M${link.x1},${link.y1} C${link.x1 + bend},${link.y1} ${link.x2 - bend},${link.y2} ${link.x2},${link.y2}`;
	}

	return {
		width: Metrics.margin * 2 + layers * Metrics.width + (layers - 1) * Metrics.columnGap,
		height: Metrics.margin * 2 + tallest,
	};
}
