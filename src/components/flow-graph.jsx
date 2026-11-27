import { useEffect, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import classNames from 'classnames';
import { Items } from '../lib/data.js';
import { buildFlow, layoutFlow, buildingForResource, Metrics } from '../lib/flow.js';
import state from '../state.js';
import Item from './item.jsx';


// The same zoom steps as the research grid
const ZoomLevels = [4, 3, 2, 1.5, 1.25, 1, 1/1.25, 1/1.5, 1/2, 1/3, 1/4];
const MaxZoom = ZoomLevels[0];
const MinZoom = 0.1; // Fitting a big graph on screen may go below the smallest step


function formatNumber(value) {
	if(value >= 100) return String(Math.round(value));
	return String(+value.toFixed(value >= 10? 1 : 2));
}

function Rate({ rate }) {
	const perSecond = state.timeScale.value === 'second';
	return (
		<span class="rate">
			{formatNumber(perSecond? rate / 60 : rate)}<span class="unit">/{perSecond? 's' : 'min'}</span>
		</span>
	);
}

function recipeName(recipe) {
	return recipe.explicit? recipe.name : Items.find(item => item.id === recipe.results[0]).name;
}

// Where cards were dragged to by hand, as offsets from the automatic layout. Kept per final recipe
const movedCards = signal({ recipe: null, offsets: new Map() });

// The card picked in the graph, whose amount can then be set from the bar above it
const selectedKey = signal(null);

// What a card counts in: buildings, veins under a mining machine, or failing that items per minute
function nodeAmount(node) {
	if(node.kind === 'recipe')
	{
		const building = Items.find(item => item.id === node.building);
		return { value: node.facilities, icon: building, label: `${building?.name || 'buildings'} making ${recipeName(node.recipe)}` };
	}
	
	const gatherer = buildingForResource(node.item);
	const building = gatherer && Items.find(item => item.id === gatherer.building);
	if(gatherer?.perVein) return { value: node.rate / gatherer.perVein, icon: building, label: `veins of ${node.item.name} under ${building.name}s` };
	if(gatherer?.perBuilding) return { value: node.rate / gatherer.perBuilding, icon: building, label: `${building.name} collecting ${node.item.name}` };
	return { value: node.rate, icon: node.item, label: `${node.item.name} per minute` };
}

// Scales the whole calculation so the picked card ends up at the given amount
function setNodeAmount(node, amount) {
	const current = nodeAmount(node).value;
	if(!(amount > 0) || !(current > 0)) return;
	const ratio = amount / current;
	state.per.value = state.per.value * ratio;
	state.factor.value = state.factor.value * ratio;
}

function FlowTarget({ node }) {
	if(!node) return (
		<div class="flow-target is-empty">Click a building in the graph to set how many of it you want to use.</div>
	);
	
	const { value, icon, label } = nodeAmount(node);
	return (
		<label class="flow-target">
			<span class="text">Use</span>
			<input
				type="number"
				min="0"
				step="1"
				value={+value.toFixed(3)}
				onInput={event => setNodeAmount(node, event.currentTarget.valueAsNumber)}
			/>
			<span class="text">&times;</span>
			{icon && <Item item={icon}/>}
			<span class="text">{label}</span>
			<button type="button" class="clear" onClick={() => selectedKey.value = null} title="Deselect">&times;</button>
		</label>
	);
}

function FlowNode({ node, isFinal }) {
	const style = { left: node.x, top: node.y, width: Metrics.width, height: node.height };
	const isSelected = selectedKey.value === node.key;

	if(node.kind === 'source')
	{
		const gatherer = buildingForResource(node.item);
		const building = gatherer && Items.find(item => item.id === gatherer.building);

		if(building) return (
			<div class={classNames('flow-node is-source', { 'is-selected': isSelected })} data-key={node.key} style={style}>
				<div class="flow-head" title={gatherer.perVein? `${gatherer.perVein} per minute from each vein, before mining speed upgrades` : undefined}>
					<Item item={building}/>
					<div class="flow-title">
						<span class="name">
							{gatherer.perBuilding && <><span class="count">{formatNumber(node.rate / gatherer.perBuilding)}&times;</span> </>}
							{building.name}
						</span>
						<span class="making">
							{gatherer.perVein?
								`mining ${node.item.name} from ${formatNumber(node.rate / gatherer.perVein)} veins` :
								`collecting ${node.item.name}`
							}
						</span>
					</div>
				</div>
				<ul class="flow-outputs">
					<li><Rate rate={node.rate}/><Item item={node.item}/></li>
				</ul>
			</div>
		);
	}

	if(node.kind === 'source') return (
		<div class={classNames('flow-node is-source', { 'is-selected': isSelected })} data-key={node.key} style={style}>
			<div class="flow-head">
				<Item item={node.item}/>
				<div class="flow-title">
					<span class="name">{node.item.name}</span>
					{node.item.miningFrom &&
						<span class="making" dangerouslySetInnerHTML={{ __html: node.item.miningFrom }}/>
					}
				</div>
			</div>
			<ul class="flow-outputs">
				<li><Rate rate={node.rate}/><Item item={node.item}/></li>
			</ul>
		</div>
	);

	const building = Items.find(item => item.id === node.building);
	const needed = Math.ceil(+node.facilities.toFixed(6));

	return (
		<div class={classNames('flow-node is-recipe', { 'is-final': isFinal, 'is-selected': isSelected })} data-key={node.key} style={style}>
			<div class="flow-head" title={`${+node.facilities.toFixed(6)}× ${building?.name || ''}, build ${needed}`}>
				{building && <Item item={building}/>}
				<div class="flow-title">
					<span class="name"><span class="count">{formatNumber(node.facilities)}&times;</span> {building?.name}</span>
					<span class="making">making {recipeName(node.recipe)}</span>
				</div>
			</div>
			<ul class="flow-inputs">
				{node.inputs.map(link =>
					<li key={link.key}><Item id={link.item}/><Rate rate={link.rate}/></li>
				)}
				{node.locked.map(id =>
					<li key={id} class="is-locked"><Item id={id}/><span class="rate">locked</span></li>
				)}
			</ul>
			<ul class="flow-outputs">
				{node.outputs.map(output =>
					<li key={output.item}><Rate rate={output.rate}/><Item id={output.item}/></li>
				)}
			</ul>
		</div>
	);
}


export default function FlowGraph({ solve, throughput }) {
	const flow = buildFlow(solve, throughput);
	const moved = movedCards.value.recipe === solve.recipe? movedCards.value.offsets : null;
	const size = layoutFlow(flow, moved);
	const latestRecipe = useRef(solve.recipe);
	latestRecipe.current = solve.recipe;

	const referenceRoot = useRef(null);
	const referencePan = useRef(null);
	const referenceZoom = useRef(null);
	const view = useRef({ x: 0, y: 0, z: 1 });
	const latestSize = useRef(size);
	latestSize.current = size;

	function apply() {
		const { x, y, z } = view.current;
		referencePan.current.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
		referenceZoom.current.textContent = `${Math.round(z * 1000) / 10}%`;
	}

	function fit() {
		const root = referenceRoot.current;
		const { width, height } = latestSize.current;

		// Fill the rest of the screen below the calculator's controls
		const top = root.getBoundingClientRect().top + window.scrollY;
		root.style.height = `${Math.max(420, window.innerHeight - top)}px`;

		const z = Math.max(MinZoom, Math.min(1, root.clientWidth / width, root.clientHeight / height));
		view.current = {
			x: (root.clientWidth - width * z) / 2,
			y: Math.max(0, (root.clientHeight - height * z) / 2),
			z,
		};
		apply();
	}

	function zoomAt(px, py, zoom) {
		const current = view.current;
		const z = Math.max(MinZoom, Math.min(MaxZoom, zoom));
		// Keep the point under the cursor in place
		current.x = px - (px - current.x) / current.z * z;
		current.y = py - (py - current.y) / current.z * z;
		current.z = z;
		apply();
	}

	// The next zoom level in or out from where we are now
	function nextZoom(direction) {
		const z = view.current.z;
		const level = direction > 0? ZoomLevels.findLast(level => level > z + 0.001) : ZoomLevels.find(level => level < z - 0.001);
		return level ?? z;
	}
	
	function zoomCentre(direction) {
		const root = referenceRoot.current;
		zoomAt(root.clientWidth / 2, root.clientHeight / 2, nextZoom(direction));
	}

	// Fit again whenever the shape of the graph changes, but not when only the amounts do
	useEffect(fit, [solve, size.width, size.height]);

	useEffect(() => {
		const root = referenceRoot.current;
		let last = null;
		let travelled = 0;
		let draggedCard = null;

		function onWheel(event) {
			event.preventDefault();
			const bounds = root.getBoundingClientRect();
			const px = event.clientX - bounds.left - root.clientLeft;
			const py = event.clientY - bounds.top - root.clientTop;

			// Mouse wheel: one step per notch, whatever the OS scroll size is (same rules as the research grid)
			const isMouseWheel = event.deltaY !== 0 && (
				event.deltaMode !== 0
				|| (event.deltaX === 0 && event.wheelDeltaY && event.wheelDeltaY % 120 === 0)
				|| (event.ctrlKey? Math.abs(event.deltaY) >= 50 : event.deltaX === 0 && Math.abs(event.deltaY) >= 100)
			);

			if(isMouseWheel) zoomAt(px, py, nextZoom(event.deltaY < 0? 1 : -1));
			else if(event.ctrlKey) zoomAt(px, py, view.current.z * Math.exp(-event.deltaY / 100)); // Trackpad pinch
			else
			{
				// Trackpad scroll
				view.current.x -= event.deltaX;
				view.current.y -= event.deltaY;
				apply();
			}
		}

		function onPointerDown(event) {
			if(event.button !== 0 || event.target.closest('button')) return;
			last = { x: event.clientX, y: event.clientY };
			travelled = 0;
			draggedCard = event.target.closest('.flow-node')?.dataset.key || null;
			root.setPointerCapture(event.pointerId);
			root.classList.add('is-dragging');
		}

		function onPointerMove(event) {
			if(!last) return;
			const dx = event.clientX - last.x, dy = event.clientY - last.y;
			if(draggedCard)
			{
				// Dragging a card moves just that card, in graph units
				const recipe = latestRecipe.current;
				const offsets = new Map(movedCards.value.recipe === recipe? movedCards.value.offsets : []);
				const offset = offsets.get(draggedCard) || { x: 0, y: 0 };
				offsets.set(draggedCard, { x: offset.x + dx / view.current.z, y: offset.y + dy / view.current.z });
				movedCards.value = { recipe, offsets };
			}
			else
			{
				view.current.x += dx;
				view.current.y += dy;
			}
			travelled += Math.abs(event.clientX - last.x) + Math.abs(event.clientY - last.y);
			last = { x: event.clientX, y: event.clientY };
			apply();
		}

		function onPointerUp(event) {
			if(!last) return;
			last = null;
			root.releasePointerCapture(event.pointerId);
			root.classList.remove('is-dragging');
			
			// A press without a drag picks the card under the cursor (or clears the pick on empty space).
			// The pointer is captured by the graph, so the card has to be found by position
			if(event.type === 'pointerup' && travelled < 5)
			{
				const card = document.elementFromPoint(event.clientX, event.clientY)?.closest('.flow-node');
				const key = card?.dataset.key || null;
				selectedKey.value = key === selectedKey.value? null : key;
			}
		}

		window.addEventListener('resize', fit);
		root.addEventListener('wheel', onWheel, { passive: false });
		root.addEventListener('pointerdown', onPointerDown);
		root.addEventListener('pointermove', onPointerMove);
		root.addEventListener('pointerup', onPointerUp);
		root.addEventListener('pointercancel', onPointerUp);

		return () => {
			window.removeEventListener('resize', fit);
			root.removeEventListener('wheel', onWheel, { passive: false });
			root.removeEventListener('pointerdown', onPointerDown);
			root.removeEventListener('pointermove', onPointerMove);
			root.removeEventListener('pointerup', onPointerUp);
			root.removeEventListener('pointercancel', onPointerUp);
		};
	}, []);

	const selected = flow.nodes.find(node => node.key === selectedKey.value);
	
	return (
		<>
		<FlowTarget node={selected}/>
		<div class="flow-graph" ref={referenceRoot}>
			<div class="flow-pan" ref={referencePan} style={{ width: size.width, height: size.height }}>
				<svg class="flow-links" width={size.width} height={size.height} viewBox={`0 0 ${size.width} ${size.height}`}>
					{flow.links.map(link =>
						<path key={link.key} d={link.path}/>
					)}
					{flow.links.map(link =>
						<circle key={link.key} cx={link.x1} cy={link.y1} r="4"/>
					)}
					{flow.links.map(link =>
						<circle key={link.key} cx={link.x2} cy={link.y2} r="4"/>
					)}
				</svg>
				{flow.nodes.map(node =>
					<FlowNode key={node.key} node={node} isFinal={node === flow.root}/>
				)}
			</div>
			<div class="flow-controls">
				<button type="button" onClick={() => zoomCentre(-1)} title="Zoom out">-</button>
				<output ref={referenceZoom}>100%</output>
				<button type="button" onClick={() => zoomCentre(1)} title="Zoom in">+</button>
				<button type="button" onClick={fit} title="Fit the whole graph on screen">Fit</button>
				{moved?.size > 0 &&
					<button type="button" onClick={() => movedCards.value = { recipe: null, offsets: new Map() }} title="Put the cards back where they were">Reset layout</button>
				}
			</div>
		</div>
		</>
	);
}
