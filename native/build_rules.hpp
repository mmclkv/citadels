#pragma once

#include <string_view>

namespace citadels::native {

struct BuildCard {
  std::string_view name;
  std::string_view color;
  int cost = 0;
};

struct BuildContext {
  std::string_view role_id;
  bool witch_resume = false;
  int gold = 0;
  int builds = 0;
  int build_limit = 1;
  int same_name_count = 0;
  int quarry_count = 0;
};

inline bool can_build(const BuildCard& card, const BuildContext& context) {
  if (card.cost > context.gold) return false;
  if (context.role_id == "navigator" && !context.witch_resume) return false;
  const bool green_free = context.role_id == "businessman" &&
                          !context.witch_resume && card.color == "green";
  if (!green_free && context.builds >= context.build_limit) return false;
  return context.same_name_count < 1 + context.quarry_count;
}

}  // namespace citadels::native
