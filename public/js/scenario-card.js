const CAT_COLORS = {
  space:          '#6a9fd8',
  military:       '#c0524a',
  'civil-rights': '#5a8a5a',
  underground:    '#b8832a',
  maritime:       '#6a9fd8',
  industrial:     '#8a6040',
};

const LOCAL_IMAGES = {
  apollo_13_lifeboat:             '/images/scenarios/apollo_13_short.jpg',
  dog_green_sector:               '/images/scenarios/dog_green_short.jpg',
  greensboro_four_the_color_line: '/images/scenarios/greensboro_four_short.jpg',
  sargasso_deep_three_keys:       '/images/scenarios/sargasso_deep_short.jpg',
};

const LOCAL_IMG_POSITION = {
  greensboro_four_the_color_line: '30% center',
};

export function renderScenarioCard(scenario, { baseUrl = '' } = {}) {
  const color    = CAT_COLORS[scenario.category] || 'rgba(196,154,60,0.4)';
  const localImg = LOCAL_IMAGES[scenario.id] || null;
  const imgSrc   = scenario.image_url || localImg;
  const imgPos   = LOCAL_IMG_POSITION[scenario.id] || 'center';
  const imgStyle = imgSrc
    ? `background-image:url('${imgSrc}');background-size:cover;background-position:${imgPos}`
    : `background:var(--card-img-gradient,linear-gradient(to bottom,#1e1a16 0%,#0d0b09 100%))`;
  const aiAttr = localImg
    ? `<span style="font-size:10px;color:rgba(255,255,255,0.45);position:absolute;bottom:6px;left:8px;letter-spacing:0.03em;pointer-events:none;font-style:italic">AI-generated illustration</span>`
    : '';
  const roles    = (scenario.roles || []).map(r => `<span class="meta-pill">${r}</span>`).join('');
  const costLine = scenario.cost_tracked
    ? `<p class="story-cost">Cost tracked: ${scenario.cost_tracked}</p>`
    : '';
  const arrow = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="rgba(245,240,232,0.5)" stroke-width="1.5"><path d="M1 5h8M5 1l4 4-4 4"/></svg>`;
  return `<div class="story-card" onclick="location.href='${baseUrl}/game?scenarioId=${scenario.id}'">
  <div class="story-card-img" style="${imgStyle};border-left:3px solid ${color};position:relative">${aiAttr}</div>
  <div class="story-card-body">
    <p class="story-era">${scenario.era || ''}</p>
    <h3 class="story-title">${scenario.title}</h3>
    <p class="story-hook">${scenario.description || ''}</p>
    ${costLine}
    <div class="story-footer">
      <div class="story-pills">${roles}</div>
      <div class="story-arrow">${arrow}</div>
    </div>
  </div>
</div>`;
}
