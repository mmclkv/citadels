#include <iostream>
#include "declaration_rules.hpp"

int main() {
  using namespace citadels::native;
  DeclarationState assassin{DeclarationKind::Assassin};
  assassin.active_numbers[2] = true;
  assassin.active_numbers[3] = true;
  DeclarationState thief{DeclarationKind::Thief};
  thief.active_numbers[3] = true;
  std::cout << declare_target(assassin, 1) << ','
            << declare_target(assassin, 2) << ','
            << assassin.declared_number << ','
            << declare_target(thief, 10) << ','
            << declare_target(thief, 1) << ','
            << declare_target(thief, 3) << ','
            << thief.declared_number << '\n';
}
