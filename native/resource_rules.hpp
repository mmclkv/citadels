#pragma once

#include <string_view>

namespace citadels::native {

enum class ResourcePhase { Main, WitchResume };
enum class DistrictDrawEffect { None, Observatory, Library };

struct ResourcePlan {
  int gold = 0;
  int drawn = 0;
  bool keep_all = false;
};

inline int role_gold_bonus(std::string_view role_id) {
  return role_id == "merchant" ? 1 : 0;
}

inline int role_draw_bonus(std::string_view role_id) {
  return role_id == "architect" ? 2 : 0;
}

inline ResourcePlan plan_take_gold(std::string_view role_id, ResourcePhase phase) {
  const int bonus = phase == ResourcePhase::Main ? role_gold_bonus(role_id) : 0;
  return {2 + bonus, 0, false};
}

inline ResourcePlan plan_take_cards(std::string_view role_id,
                                    ResourcePhase phase,
                                    DistrictDrawEffect effect) {
  const int role_bonus = phase == ResourcePhase::Main ? role_gold_bonus(role_id) : 0;
  const int draw_bonus = phase == ResourcePhase::Main ? role_draw_bonus(role_id) : 0;
  const int drawn = effect == DistrictDrawEffect::Observatory ? 3 : 2;
  const bool keep_all = effect == DistrictDrawEffect::Library;
  return {role_bonus, drawn + draw_bonus, keep_all};
}

}  // namespace citadels::native
