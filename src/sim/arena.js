export const bounds = { 
  width: window.innerWidth, 
  height: window.innerHeight 
};

export function wrap(entity) {
  if (entity.x < 0) entity.x += bounds.width;
  if (entity.x >= bounds.width) entity.x -= bounds.width;
  if (entity.y < 0) entity.y += bounds.height;
  if (entity.y >= bounds.height) entity.y -= bounds.height;
}