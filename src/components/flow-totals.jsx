import { Items } from '../lib/data.js';
import { buildFlow, buildingForResource, bestSorter, sortersForNode } from '../lib/flow.js';
import state from '../state.js';
import Item from './item.jsx';


function formatNumber(value) {
	if(value >= 100) return String(Math.round(value));
	return String(+value.toFixed(value >= 10? 1 : 2));
}

function formatRate(rate) {
	const perSecond = state.timeScale.value === 'second';
	return `${formatNumber(perSecond? rate / 60 : rate)} per ${perSecond? 'second' : 'minute'}`;
}

// Whole buildings needed for a step: 0.33 of a smelter still means building one
function wholeBuildings(amount) {
	return Math.ceil(+amount.toFixed(6));
}

function recipeName(recipe) {
	return recipe.explicit? recipe.name : Items.find(item => item.id === recipe.results[0]).name;
}


// Adds up every building in the production chain, from the same graph the Graph view draws
export default function FlowTotals({ solve, throughput }) {
	const flow = buildFlow(solve, throughput);

	const sorter = bestSorter();
	const buildings = new Map(); // building id → { build, exact, uses }
	const resources = []; // gathered resources that have no fixed building count

	function add(id, exact, use) {
		if(!buildings.has(id)) buildings.set(id, { id, build: 0, exact: 0, uses: [] });
		const total = buildings.get(id);
		total.build += wholeBuildings(exact);
		total.exact += exact;
		total.uses.push(use);
	}

	for(const node of flow.nodes)
	{
		if(node.kind === 'recipe')
		{
			if(node.building) add(node.building, node.facilities, { amount: node.facilities, name: recipeName(node.recipe) });
			const sorters = sortersForNode(node, sorter);
			if(sorters) add(sorter.item.id, sorters, { amount: sorters, name: recipeName(node.recipe) });
		}

		else if(node.kind === 'splitter')
		{
			add(2020 /* Splitter */, 1, { amount: 1, name: node.item.name });
		}

		else if(node.kind === 'source')
		{
			const gatherer = buildingForResource(node.item);
			if(gatherer?.perBuilding) add(gatherer.building, node.rate / gatherer.perBuilding, { amount: node.rate / gatherer.perBuilding, name: node.item.name });
			else resources.push({ node, gatherer });
		}
	}

	const rows = Array.from(buildings.values()).sort((a, b) => b.build - a.build);
	const totalBuild = rows.reduce((sum, row) => sum + row.build, 0);

	return (
		<div class="flow-totals">
			<table>
				<caption>Buildings to set up</caption>
				<thead>
					<tr>
						<th scope="col">Build</th>
						<th scope="col">Building</th>
						<th scope="col">Exact need</th>
						<th scope="col">Used for</th>
					</tr>
				</thead>
				<tbody>
					{rows.map(row =>
						<tr key={row.id}>
							<td class="build">{row.build}&times;</td>
							<td class="building"><Item id={row.id} named/></td>
							<td class="exact">{formatNumber(row.exact)}</td>
							<td class="uses">
								{row.uses
									.sort((a, b) => b.amount - a.amount)
									.map(use => `${wholeBuildings(use.amount)}× ${use.name}`)
									.join(', ')
								}
							</td>
						</tr>
					)}
				</tbody>
				<tfoot>
					<tr>
						<td class="build">{totalBuild}&times;</td>
						<td colspan="3">buildings in total</td>
					</tr>
				</tfoot>
			</table>

			{resources.length > 0 && (
				<table>
					<caption>Resources to gather</caption>
					<thead>
						<tr>
							<th scope="col">Need</th>
							<th scope="col">Resource</th>
							<th scope="col">Gathered with</th>
							<th scope="col">Amount</th>
						</tr>
					</thead>
					<tbody>
						{resources.map(({ node, gatherer }) =>
							<tr key={node.key}>
								<td class="build">
									{gatherer?.perVein? `${wholeBuildings(node.rate / gatherer.perVein)} veins` : ''}
								</td>
								<td class="building"><Item item={node.item} named/></td>
								<td class="building">{gatherer? <Item id={gatherer.building} named/> : 'By hand'}</td>
								<td class="uses">{formatRate(node.rate)}</td>
							</tr>
						)}
					</tbody>
				</table>
			)}

			<p class="note">
				"Build" rounds every production step up to whole buildings, so it can be higher than the exact need.
				Sorters use the fastest type your research has unlocked ({sorter.item.name}, {formatRate(sorter.perMinute)} at the shortest reach, without stacking upgrades),
				with enough on every input and output of each building to keep it running flat out.
				Mining machines are counted in veins (30 per minute each, before mining speed upgrades), since one machine covers several veins.
			</p>
		</div>
	);
}
