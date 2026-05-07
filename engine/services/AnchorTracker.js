export class AnchorTracker {
  constructor(scenarioAnchors = []) {
    this.usedAnchors = new Map();
    this.scenarioAnchors = scenarioAnchors;
    this.universalPatterns = [
      /\b(dispatch|packet|letter|paper)\b.{0,30}\b(ribs?|chest|coat|body)\b/i,
      /\bcandle\b.{0,20}\b(gutter|gutters|guttering|low|stub|nearly gone|almost gone)\b/i,
      /\bspectacles\b.{0,40}\b(not put on|pocket|does not|didn't)\b/i,
      /\bcold\b.{0,20}\b(gap|collar|wrist|neck|finds)\b/i,
      /\b(ink|linseed|tallow)\b.{0,10}\b(smell|scent|odour)\b/i,
    ];
  }

  check(sceneText) {
    const violations = [];

    this.universalPatterns.forEach((pattern, index) => {
      const matches = sceneText.match(pattern);
      if (matches) {
        const key = `universal_${index}`;
        const count = this.usedAnchors.get(key) || 0;
        if (count >= 1) {
          violations.push({
            type: 'universal',
            pattern: pattern.toString(),
            match: matches[0],
            uses: count + 1,
          });
        }
        this.usedAnchors.set(key, count + 1);
      }
    });

    this.scenarioAnchors.forEach(anchor => {
      const key = anchor.toLowerCase();
      const words = key.split(' ').filter(w => w.length > 3);
      const pattern = new RegExp(words.join('.{0,20}'), 'i');
      const matches = sceneText.match(pattern);
      if (matches) {
        const count = this.usedAnchors.get(key) || 0;
        if (count >= 1) {
          violations.push({
            type: 'scenario',
            anchor: anchor,
            match: matches[0],
            uses: count + 1,
          });
        }
        this.usedAnchors.set(key, count + 1);
      }
    });

    return violations;
  }

  getSummary() {
    return Object.fromEntries(this.usedAnchors);
  }
}
