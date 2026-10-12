// Graphics presets. Grass and view distance are what cost the most on slow GPUs.
export const QUALITY = [
  { name: 'low', grass: 0.4, terrainView: 2, grassRing: 1, islandView: 4, highRing: 2 },
  { name: 'medium', grass: 0.7, terrainView: 3, grassRing: 2, islandView: 6, highRing: 3 },
  { name: 'high', grass: 1, terrainView: 3, grassRing: 2, islandView: 7, highRing: 3 },
];
