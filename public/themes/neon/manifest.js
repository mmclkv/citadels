/*
 * 暗夜赛博霓虹-女性力量主题的资源清单。
 * 路径相对于 public/index.html，角色使用稳定 id，建筑使用稳定 district_<英文 key>。
 */
(function (root) {
  'use strict';

  const base = 'assets/themes/neon/cards/';
  const roleIds = [
    'assassin', 'witch', 'thief', 'magician', 'prophet', 'king', 'emperor',
    'noble', 'bishop', 'monk', 'merchant', 'alchemist', 'businessman',
    'architect', 'navigator', 'scholar', 'warlord', 'diplomat', 'marshal',
    'queen', 'artist'
  ];
  const districtKeys = [
    'manor', 'castle', 'palace', 'temple', 'church', 'monastery', 'cathedral',
    'tavern', 'market', 'trading_post', 'docks', 'harbor', 'town_hall',
    'watchtower', 'prison', 'battlefield', 'fortress', 'ghost_town', 'keep',
    'museum', 'graveyard', 'laboratory', 'smithy', 'observatory', 'library',
    'school_of_magic', 'dragon_gate', 'university', 'great_wall', 'quarry'
  ];

  function variants(folder, key) {
    return {
      thumb: base + folder + '/thumb/' + key + '.webp',
      full: base + folder + '/full/' + key + '.webp'
    };
  }

  const roles = {};
  roleIds.forEach(id => { roles[id] = variants('roles', id); });
  const districts = {};
  districtKeys.forEach(key => { districts['district_' + key] = variants('districts', key); });

  root.CitadelThemeManifests = root.CitadelThemeManifests || {};
  root.CitadelThemeManifests.neon = {
    id: 'neon',
    label: '暗夜赛博霓虹-女性力量',
    cards: { roles: roles, districts: districts }
  };
})(typeof self !== 'undefined' ? self : this);
