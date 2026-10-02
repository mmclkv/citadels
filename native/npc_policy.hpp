#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <string>
#include <vector>

#include "game_adapter.hpp"

namespace citadels::native {

// Native counterpart of python_backend/bot.py. It only ranks actions already
// produced by NativeGameAdapter, so it cannot invent an action the rules reject.
class NativeNpcPolicy {
 public:
  static int choose(const NativeGameState& state, int player,
                    const std::vector<NativeSearchAction>& actions,
                    uint32_t seed = 1) {
    if (player < 0 || player >= static_cast<int>(state.players.size()) || actions.empty()) return -1;
    const auto& p = state.players[player];
    uint32_t random = seed ? seed : 1;
    int best = 0;
    double best_score = -std::numeric_limits<double>::infinity();
    for (size_t i = 0; i < actions.size(); ++i) {
      const auto score = score_action(state, player, actions[i], random) - i * 1e-7;
      if (score > best_score) { best_score = score; best = static_cast<int>(i); }
    }
    (void)p;
    return best;
  }

 private:
  static uint32_t next_random(uint32_t& state) {
    state ^= state << 13; state ^= state >> 17; state ^= state << 5; return state;
  }
  static double noise(uint32_t& state, double scale) {
    return (static_cast<double>(next_random(state) & 0xffff) / 65535.0 - 0.5) * scale;
  }
  static int color_count(const NativePlayer& p, const std::string& color) {
    return static_cast<int>(std::count_if(p.city.begin(), p.city.end(), [&](const auto& d) {
      return d.card.color == color || (color == "green" && d.effect == "anyColorIncome");
    }));
  }
  static const DistrictCard* card_by_uid(const std::vector<DistrictCard>& cards, const std::string& uid) {
    const auto it = std::find_if(cards.begin(), cards.end(), [&](const auto& c) { return c.uid == uid; });
    return it == cards.end() ? nullptr : &*it;
  }
  static double card_value(const NativeGameState& s, const NativePlayer& p, const DistrictCard& c) {
    double value = c.cost * 1.05;
    const bool color_exists = std::any_of(p.city.begin(), p.city.end(), [&](const auto& d) { return d.card.color == c.color; });
    if (!color_exists) value += 2.2;
    if (color_exists) value += std::min(1.2, color_count(p, c.color) * 0.25);
    if (c.color == "purple") value += 1.2;
    if (c.purple_effect == "scoreAs") value += 0.8;
    else if (c.purple_effect == "keepBoth" || c.purple_effect == "draw3keep1" ||
             c.purple_effect == "smithy" || c.purple_effect == "lab" || c.purple_effect == "immune") value += 1.0;
    else if (c.purple_effect == "anyColorIncome") value += color_count(p, "blue") == 0 ? 1.8 : 0.8;
    else if (c.purple_effect == "extraBuild") value += 1.8;
    const int left = std::max(0, s.end_districts - static_cast<int>(p.city.size()));
    if (left <= 2) value += c.cost * 0.35;
    if (left == 1) value += 9;
    if (left == 0) value -= 8;
    return value;
  }
  static int leader(const NativeGameState& s) {
    int best = 0, score = -1;
    for (size_t i = 0; i < s.players.size(); ++i) {
      int current = static_cast<int>(s.players[i].city.size()) * 2;
      for (const auto& d : s.players[i].city) current += d.card.cost;
      if (current > score) { score = current; best = static_cast<int>(i); }
    }
    return best;
  }
  static bool should_use_ability(const NativeGameState& s, int index) {
    const auto& p = s.players[index];
    const auto& role = p.role_id;
    if (role == "assassin" || role == "thief" || role == "witch" || role == "magician" ||
        role == "magistrate" || role == "spy" || role == "blackmailer" || role == "wizard" ||
        role == "tax_collector" || role == "emperor" || role == "scholar" || role == "prophet") return true;
    const int top = leader(s);
    if (role == "warlord") return p.gold >= 1 && top != index &&
      s.players[top].city.size() < static_cast<size_t>(s.end_districts) && p.city.size() <= s.players[top].city.size();
    if (role == "marshal") return p.gold >= 2 && top != index && s.players[top].city.size() > p.city.size();
    if (role == "diplomat") return p.gold >= 1 && top != index &&
      std::any_of(p.city.begin(), p.city.end(), [](const auto& d) { return !d.fortress && d.effect != "scoreAs"; });
    if (role == "artist") return p.gold >= 3 && p.city.size() >= 2;
    if (role == "navigator") return !s.bonus_done;
    return false;
  }
  static std::string role_income(const std::string& role) {
    if (role == "king" || role == "noble" || role == "emperor") return "yellow";
    if (role == "bishop" || role == "abbot" || role == "monk") return "blue";
    if (role == "merchant" || role == "alchemist" || role == "businessman") return "green";
    if (role == "warlord" || role == "diplomat" || role == "marshal") return "red";
    return {};
  }
  static double role_value(const NativeGameState& s, int index, const std::string& role) {
    const auto& p = s.players[index];
    const int hand_cost = [&] { int n = 0; for (const auto& c : p.hand) n += c.cost; return n; }();
    const int behind = static_cast<int>(s.players[leader(s)].city.size()) - static_cast<int>(p.city.size());
    double v = 0;
    if (role == "architect") v += 1.2;
    else if (role == "merchant") v += 0.6;
    else if (role == "bishop") v += 0.8 + color_count(p, "blue") * 0.2;
    else if (role == "warlord") v += color_count(p, "red") * 0.3 + (behind >= 2 ? 2 : 0) + (p.gold >= 4 ? 0.8 : 0);
    else if (role == "diplomat" || role == "marshal") v += (behind >= 2 ? (role == "marshal" ? 1.4 : 1.2) : 0) + color_count(p, "red") * 0.3;
    else if (role == "thief") { int wealth = 0; for (size_t i=0;i<s.players.size();++i) if (static_cast<int>(i)!=index) wealth=std::max(wealth,s.players[i].gold); v += std::min(3,wealth) * 0.45; }
    else if (role == "assassin") v += 1;
    else if (role == "magician") v += p.hand.size() <= 1 ? 1.6 : 0.2;
    else if (role == "king") v += 0.7 + (!p.has_crown ? 0.5 : 0);
    else if (role == "noble") v += color_count(p, "yellow") * 0.9;
    else if (role == "navigator" || role == "scholar" || role == "prophet") v += role == "scholar" ? 1.2 : 0.9;
    else if (role == "alchemist") v += p.gold >= 6 ? 1.5 : 0.1;
    else if (role == "businessman") v += color_count(p, "green") * 0.3;
    else if (role == "monk") v += color_count(p, "blue") * 0.8;
    else if (role == "artist") v += p.gold >= 4 ? 1.4 : 0;
    else if (role == "queen") v += 0.5;
    else if (role == "witch") v += 0.9;
    else if (role == "emperor") v += 0.4;
    if (p.hand.size() <= 1 && (role == "scholar" || role == "architect")) v += 2;
    if (p.gold >= 5 && hand_cost >= 5 && (role == "architect" || role == "scholar")) v += 1.2;
    if (static_cast<int>(p.city.size()) >= s.end_districts - 2 &&
        (role == "architect" || role == "prophet" || role == "scholar")) v += 1.4;
    return v;
  }
  static double score_action(const NativeGameState& s, int index,
                             const NativeSearchAction& a, uint32_t& rng) {
    const auto& p = s.players[index];
    const auto type = a.type;
    if (type == ActionType::ConfirmRound) return 100;
    if (type == ActionType::Reaction) {
      const bool use = a.name == "use";
      if (s.reaction_kind == "magistrate" || s.reaction_kind == "blackmailer") return use ? 100 : 0;
      const auto& c = s.reaction_card;
      return use == (c.cost >= 3 && p.gold >= 2) ? 80 : 0;
    }
    if (type == ActionType::DraftPick || type == ActionType::DraftDiscard) {
      const double value = role_value(s, index, a.name);
      const double noise_scale = p.bot_level == "easy" ? 4.0 : p.bot_level == "hard" ? 0.25 : 1.2;
      return (type == ActionType::DraftPick ? value : -value) + noise(rng, noise_scale);
    }
    if (s.pending_kind == "blackmailer_threat") return type == (p.gold >= 4 ? ActionType::BlackmailerBribe : ActionType::BlackmailerRefuse) ? 100 : 0;
    if (s.pending_kind == "wizard_choice") return type == (s.pending_cards.size() && p.gold >= s.pending_cards[0].cost ? ActionType::WizardBuild : ActionType::WizardTake) ? 100 : -10;
    if (s.pending_kind == "magician_choice") {
      int max_hand = 0; for (size_t i=0;i<s.players.size();++i) if (static_cast<int>(i)!=index) max_hand=std::max(max_hand, static_cast<int>(s.players[i].hand.size()));
      const bool swap = (p.hand.size() <= 1 && max_hand >= 2) || (p.hand.size() >= 3 && max_hand >= 4);
      return (a.mode == (swap ? "swap" : "redraw")) ? 30 : 0;
    }
    if (s.pending_kind == "navigator_bonus") return a.mode == ((p.gold < 6) ? "gold" : "cards") ? 20 : 0;
    if (s.pending_kind == "emperor_take") {
      const int target = s.pending_target;
      return a.mode == ((target >= 0 && s.players[target].gold >= 2) ? "gold" : "card") ? 20 : 0;
    }
    if (s.pending_kind == "spy_color") {
      const int target = s.pending_target;
      if (target >= 0) { int best=0; std::string color; for (const auto& d:s.players[target].city) { int count=color_count(s.players[target],d.card.color); if(count>best){best=count;color=d.card.color;} } if(a.color==color) return 30; }
      return 1;
    }
    if (s.pending_kind.empty() && s.has_turn && s.active_player == index && s.turn_phase == "bewitched")
      return type == ActionType::TakeGold ? 90 : -10;
    if (s.pending_kind.empty() && s.has_turn && s.active_player == index && !s.resources_taken) {
      if (p.role_id == "navigator") return type == (p.gold < 6 ? ActionType::TakeGold : ActionType::TakeCards) ? 80 : 0;
      const bool hand_poor = p.hand.size() <= 1;
      const bool gold_hungry = p.gold < 3;
      const int best_cost = [&] { int value=1000; for(const auto& c:p.hand) if(c.cost<=p.gold+2) value=std::min(value,c.cost); return value; }();
      const bool near_finish = p.city.size() >= static_cast<size_t>(std::max(0,s.end_districts-2));
      const double gold_score = (p.gold < 2 ? 1.2 : 0) + (near_finish ? 2 : 0) + (gold_hungry && best_cost < 1000 ? 1.0 : 0);
      const double card_score = (hand_poor ? 2.6 : 0) + (p.hand.size() <= 2 ? 1.0 : 0);
      const auto wanted = gold_score > card_score || (gold_hungry && best_cost < 1000)
        ? ActionType::TakeGold : ActionType::TakeCards;
      return type == wanted ? 80 : 0;
    }
    if (s.pending_kind.empty() && s.has_turn && s.active_player == index &&
        !s.ability_used && type == ActionType::Ability)
      return should_use_ability(s,index) ? 110 : -30;
    if (s.pending_kind.empty() && s.has_turn && s.active_player == index && !s.income_taken && type == ActionType::Income) {
      const auto income = role_income(p.role_id);
      const bool any_color = std::any_of(p.city.begin(),p.city.end(),[](const auto& d){return d.effect=="anyColorIncome";});
      return (!income.empty() && (color_count(p,income)>0 || any_color)) ? 105 : 0;
    }
    if (type == ActionType::BlackmailerSigned || type == ActionType::MagistrateSigned || type == ActionType::MagistrateChar || type == ActionType::BlackmailerChar || type == ActionType::ChooseChar) {
      // Prefer character numbers with strong income/ability utility. Preserve a
      // little stochasticity to keep NPC role selection from being predictable.
      static const double base[] = {0,2.2,1.5,2.0,1.8,1.7,2.2,2.1,2.0,1.4};
      return (a.num >= 0 && a.num < 10 ? base[a.num] : 1.0) + noise(rng, p.bot_level == "hard" ? 0.6 : 2.0);
    }
    if (type == ActionType::ChoosePlayer || type == ActionType::SpyTarget || type == ActionType::WizardTarget || type == ActionType::EmperorCrown) {
      const auto it = std::find_if(s.players.begin(), s.players.end(), [&](const auto& x) { return x.id == a.target; });
      if (it == s.players.end()) return 0;
      const int target = static_cast<int>(it - s.players.begin());
      const auto& t = *it;
      if (s.pending_kind == "emperor_crown") return -static_cast<double>(t.city.size()) * 2 - t.gold * 0.3;
      if (s.pending_kind == "magician_swap") return static_cast<double>(t.hand.size()) * 0.9 + t.gold * 0.2;
      if (s.pending_kind == "bishop_payer") return t.gold;
      return t.hand.size() * 0.9 + t.gold * 0.25 + t.city.size() * 0.7 + (target == leader(s) ? 3 : 0);
    }
    if (type == ActionType::Build) {
      const auto* c = card_by_uid(p.hand, a.uid);
      return 100 + (c ? card_value(s, p, *c) : 0);
    }
    if (type == ActionType::TakeGold) return p.gold < 3 ? 70 : 38;
    if (type == ActionType::TakeCards) return p.hand.size() < 2 ? 68 : 35;
    if (type == ActionType::Income) return 65;
    if (type == ActionType::Ability) return 75;
    if (type == ActionType::AbilitySkip || type == ActionType::EndTurn || type == ActionType::PendingBack) return -20;
    if (type == ActionType::Smithy) return 90;
    if (type == ActionType::Lab || type == ActionType::Museum) {
      const auto* c = card_by_uid(p.hand, a.secondary_uid);
      if (type == ActionType::Lab) return c ? -card_value(s,p,*c) : 0;
      return c ? -card_value(s,p,*c) : 0;
    }
    if (type == ActionType::DrawKeep || type == ActionType::ScholarPick || type == ActionType::WizardCard) {
      const auto* c = card_by_uid(s.pending_cards, a.uid);
      if (!c) c = card_by_uid(s.players[index].hand, a.uid);
      return c ? card_value(s,p,*c) : 0;
    }
    if (type == ActionType::ProphetGive) { const auto* c=card_by_uid(p.hand,a.uid); return c ? -card_value(s,p,*c) : 0; }
    if (type == ActionType::ChooseCards) {
      double score = 0; for (const auto& uid : a.selected_uids) { const auto* c=card_by_uid(p.hand,uid); if(c) score-=card_value(s,p,*c); }
      if (s.pending_kind == "magician_redraw") score += a.mode == "use" ? 1 : 0;
      return score;
    }
    if (type == ActionType::ChooseDistrict) {
      const NativeDistrict* d=nullptr;
      for (const auto& owner:s.players) for (const auto& district:owner.city) if(district.card.uid==a.uid) d=&district;
      if (!d) return 0;
      double score=d->card.cost*1.2;
      if (s.pending_kind == "artist") return d->card.cost;
      if (s.pending_kind == "diplomat_mine") return -(d->card.cost + (d->card.color=="purple" ? 4 : 0));
      return score + (a.target != p.id && std::find_if(s.players.begin(),s.players.end(),[&](const auto& x){return x.id==a.target;}) == s.players.begin()+leader(s) ? 2 : 0);
    }
    if (type == ActionType::ArtistDone) return -10;
    if (type == ActionType::MonkTake) {
      int richest=0; for(size_t i=0;i<s.players.size();++i) if(static_cast<int>(i)!=index) richest=std::max(richest,s.players[i].gold);
      return richest > p.gold ? 80 : -1;
    }
    if (type == ActionType::MonkResource || type == ActionType::AbbotResource) {
      return (p.gold < 6 ? a.gold : a.cards) * 0.1 - std::abs(a.gold - std::max(0, 6-p.gold))*0.01;
    }
    if (type == ActionType::EmperorTake) return a.mode == "gold" ? 1 : 0;
    if (type == ActionType::TaxCollect || type == ActionType::BlackmailerBribe) return 10;
    return 5;
  }
};

}  // namespace citadels::native
