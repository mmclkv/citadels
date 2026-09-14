#include <iostream>
#include "resource_rules.hpp"

int main() {
  using namespace citadels::native;
  const auto merchant = plan_take_gold("merchant", ResourcePhase::Main);
  const auto architect = plan_take_cards("architect", ResourcePhase::Main,
                                         DistrictDrawEffect::None);
  const auto observatory = plan_take_cards("merchant", ResourcePhase::Main,
                                           DistrictDrawEffect::Observatory);
  const auto library = plan_take_cards("merchant", ResourcePhase::Main,
                                       DistrictDrawEffect::Library);
  const auto witch = plan_take_gold("merchant", ResourcePhase::WitchResume);
  std::cout << merchant.gold << ',' << architect.drawn << ',' << observatory.drawn
            << ',' << library.drawn << ',' << witch.gold << '\n';
}
