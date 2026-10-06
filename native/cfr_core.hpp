#pragma once

#include <algorithm>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <limits>
#include <random>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>
#include "json_value.hpp"
#include "state_writer.hpp"
#include "state_loader.hpp"

namespace citadels::native {

struct CfrEntry {
  std::vector<std::string> actions;
  std::vector<double> regrets, strategy_sum, baseline;
  // Values are stored multiplied by exp(-scale). Separate scales preserve
  // regret matching and average-policy normalization without weight clipping.
  double regret_scale = 0, strategy_scale = 0;
};
inline std::vector<double> cfr_normalize(const std::vector<double>& values) {
  if (values.empty()) throw std::runtime_error("CFR has no legal actions");
  std::vector<double> policy(values.size());
  double scale = 0;
  for (double v : values) {
    if (!std::isfinite(v)) throw std::runtime_error("Nonfinite CFR accumulator");
    scale = std::max(scale, v);
  }
  if (scale <= 0) { std::fill(policy.begin(), policy.end(), 1.0 / values.size()); return policy; }
  double total = 0;
  for (size_t a = 0; a < values.size(); ++a) total += policy[a] = std::max(0.0, values[a]) / scale;
  for (auto& p : policy) p /= total;
  return policy;
}
inline size_t cfr_sample(const std::vector<double>& policy, std::mt19937& rng) {
  return std::discrete_distribution<size_t>(policy.begin(), policy.end())(rng);
}

class CfrTable {
 public:
  std::string contract;
  uint64_t iterations = 0, episodes = 0;
  CfrEntry& lookup(const std::string& information, const std::vector<std::string>& actions) {
    if (actions.empty() || !std::is_sorted(actions.begin(), actions.end()) ||
        std::adjacent_find(actions.begin(), actions.end()) != actions.end())
      throw std::runtime_error("CFR requires sorted distinct semantic actions");
    auto [it, inserted] = entries.try_emplace(information);
    auto& entry = it->second;
    if (inserted) {
      entry.actions = actions; entry.regrets.assign(actions.size(), 0); entry.strategy_sum.assign(actions.size(), 0);
      entry.baseline.assign(actions.size(),0);
    } else if (entry.actions != actions) {
      throw std::runtime_error("CFR information set has inconsistent legal action support");
    }
    return entry;
  }
  std::vector<double> average(const std::string& information,
                              const std::vector<std::string>& actions, bool& hit) const {
    const auto found = entries.find(information); hit = found != entries.end();
    if (!hit) return cfr_normalize(std::vector<double>(actions.size(), 0));
    if (found->second.actions != actions) throw std::runtime_error("CFR policy action support mismatch");
    hit = std::any_of(found->second.strategy_sum.begin(), found->second.strategy_sum.end(),
                       [](double weight) { return weight > 0; });
    return cfr_normalize(found->second.strategy_sum);
  }
  void save(std::ostream& out) const {
    out << "{\"format\":\"citadels-mccfr-v2\",\"contract\":";
    write_json_string(out, contract);
    out << ",\"iterations\":" << iterations << ",\"episodes\":" << episodes << "}\n";
    out << std::setprecision(std::numeric_limits<double>::max_digits10);
    for (const auto& [information, entry] : entries) {
      out << "{\"information\":"; write_json_string(out, information);
      out << ",\"actions\":"; write_json_strings(out, entry.actions);
      out << ",\"regrets\":[";
      for (size_t a = 0; a < entry.regrets.size(); ++a) { if (a) out << ','; out << entry.regrets[a]; }
      out << "],\"strategy\":[";
      for (size_t a = 0; a < entry.strategy_sum.size(); ++a) { if (a) out << ','; out << entry.strategy_sum[a]; }
      out << "],\"baseline\":[";
      for (size_t a=0;a<entry.baseline.size();++a){if(a)out<<',';out<<entry.baseline[a];}
      out << "],\"regretScale\":" << entry.regret_scale
          << ",\"strategyScale\":" << entry.strategy_scale << "}\n";
    }
    if (!out) throw std::runtime_error("CFR checkpoint write failed");
  }
  void load(std::istream& input, const std::string& expected_contract) {
    CfrTable replacement; std::string line;
    if (!std::getline(input, line)) throw std::runtime_error("Empty CFR checkpoint");
    const auto header = parse_json(line);
    if (string_field(header, "format") != "citadels-mccfr-v2" ||
        string_field(header, "contract") != expected_contract)
      throw std::runtime_error("Incompatible CFR rules/catalog/information schema");
    replacement.contract = expected_contract;
    const auto counter = [&](const char* field) {
      const auto& v = required_field(header, field);
      if (!v.is_number() || v.as_number() < 0 || v.as_number() > 9007199254740991.0 ||
          std::floor(v.as_number()) != v.as_number()) throw std::runtime_error("Invalid CFR counter");
      return static_cast<uint64_t>(v.as_number());
    };
    replacement.iterations = counter("iterations"); replacement.episodes = counter("episodes");
    while (std::getline(input, line)) {
      const auto record = parse_json(line); const auto info = string_field(record, "information");
      if (info.empty() || replacement.entries.count(info)) throw std::runtime_error("Duplicate/empty CFR information key");
      auto& entry = replacement.lookup(info, string_array_field(record, "actions"));
      const auto read = [&](const char* field, std::vector<double>& destination, bool nonnegative) {
        const auto& v = required_field(record, field);
        if (!v.is_array() || v.as_array().size() != entry.actions.size()) throw std::runtime_error("Invalid CFR array size");
        for (size_t a = 0; a < destination.size(); ++a) {
          const auto& x = v.as_array()[a];
          if (!x.is_number() || !std::isfinite(x.as_number()) || (nonnegative && x.as_number() < 0))
            throw std::runtime_error("Invalid CFR accumulator");
          destination[a] = x.as_number();
        }
      };
      read("regrets", entry.regrets, false); read("strategy", entry.strategy_sum, true);
      read("baseline",entry.baseline,false);
      for(double b:entry.baseline)if(std::abs(b)>1)throw std::runtime_error("Invalid CFR baseline");
      const auto scale = [&](const char* field) {
        const auto& x = required_field(record, field);
        if (!x.is_number() || !std::isfinite(x.as_number())) throw std::runtime_error("Invalid CFR accumulator scale");
        return x.as_number();
      };
      entry.regret_scale = scale("regretScale"); entry.strategy_scale = scale("strategyScale");
    }
    if (!input.eof()) throw std::runtime_error("CFR checkpoint read failed");
    *this = std::move(replacement);
  }
  std::unordered_map<std::string, CfrEntry> entries;
};

struct CfrTraceStep {
  std::string information;
  int actor = -1;
  size_t selected = 0;
  std::vector<double> policy;
  double sampling_probability = 0;
  long double log_my_reach = 0, log_opponent_reach = 0, log_sample_reach = 0;
  std::vector<double> baseline; // Frozen before sampling; own-payoff baseline only.
};

// Baseline-corrected outcome-sampling estimator. Tail estimates already
// include policy/sample ratios, so prefix weighting is applied only once.
// Chance is a uniformly sampled initial uint32 seed; all subsequent
// engine randomness is deterministic conditional on that latent seed. Its
// probability cancels in counterfactual weights; the constant inverse seed
// probability in average-policy sums is omitted (normalization cancels it).
inline void cfr_update_episode(CfrTable& table, const std::vector<CfrTraceStep>& trace,
                                int update_player, double terminal_utility) {
  if (!std::isfinite(terminal_utility)) throw std::runtime_error("Invalid MCCFR terminal utility");
  struct SignedLog { int sign = 0; long double magnitude = 0; };
  const auto from_double=[](double v)->SignedLog {
    return {v>0?1:v<0?-1:0,v==0?0:std::log(std::abs(static_cast<long double>(v)))};
  };
  const auto combine=[](SignedLog a,SignedLog b)->SignedLog {
    if(!a.sign)return b;if(!b.sign)return a;
    if(a.magnitude<b.magnitude)std::swap(a,b);
    if(a.sign==b.sign)return {a.sign,a.magnitude+std::log1p(std::exp(b.magnitude-a.magnitude))};
    if(a.magnitude==b.magnitude)return {};
    return {a.sign,a.magnitude+std::log(-std::expm1(b.magnitude-a.magnitude))};
  };
  const auto multiply=[](SignedLog a,long double log_factor)->SignedLog {
    if(log_factor==-std::numeric_limits<long double>::infinity())return {};
    if(a.sign)a.magnitude+=log_factor;return a;
  };
  struct Delta { std::string key; std::vector<SignedLog> regrets, average; size_t selected=0; double target=0; bool learn_baseline=false; };
  std::vector<Delta> deltas;
  SignedLog value{terminal_utility > 0 ? 1 : terminal_utility < 0 ? -1 : 0,
                  terminal_utility == 0 ? 0 : std::log(std::abs(static_cast<long double>(terminal_utility)))};
  for (auto it = trace.rbegin(); it != trace.rend(); ++it) {
    const auto& step = *it;
    if (!std::isfinite(step.sampling_probability) || step.sampling_probability <= 0 ||
        step.selected >= step.policy.size() || !std::isfinite(step.log_sample_reach))
      throw std::runtime_error("Invalid MCCFR sampling probability");
    for (double p : step.policy) if (!std::isfinite(p) || p < 0 || p > 1)
      throw std::runtime_error("Invalid MCCFR policy");
    if(step.actor!=update_player) {
      value=multiply(value,step.policy[step.selected]==0?-std::numeric_limits<long double>::infinity():
        std::log(static_cast<long double>(step.policy[step.selected])/step.sampling_probability));
      continue;
    }
    if(!step.baseline.empty() && step.baseline.size()!=step.policy.size())throw std::runtime_error("Invalid baseline size");
    std::vector<SignedLog> children(step.policy.size());
    for(size_t a=0;a<children.size();++a) {
      const double b=step.baseline.empty()?0:step.baseline[a];
      if(!std::isfinite(b)||std::abs(b)>1)throw std::runtime_error("Invalid frozen baseline");
      children[a]=from_double(b);
    }
    Delta delta;delta.key=step.information;delta.selected=step.selected;delta.learn_baseline=!step.baseline.empty();
    // Only baseline fitting is bounded. The regret/value estimator and
    // importance weights below are never clipped.
    delta.target=value.sign*(value.magnitude>=0?1:static_cast<double>(std::exp(value.magnitude)));
    auto negative_baseline=children[step.selected];negative_baseline.sign=-negative_baseline.sign;
    children[step.selected]=combine(children[step.selected],multiply(combine(value,negative_baseline),
       -std::log(static_cast<long double>(step.sampling_probability))));
    value={};
    for(size_t a=0;a<children.size();++a)if(step.policy[a]>0)
      value=combine(value,multiply(children[a],std::log(static_cast<long double>(step.policy[a]))));
    const auto weight = step.log_opponent_reach - step.log_sample_reach;
    const auto average_weight = step.log_my_reach - step.log_sample_reach;
    for (size_t a = 0; a < step.policy.size(); ++a) {
      auto negative_value=value;negative_value.sign=-negative_value.sign;
      delta.regrets.push_back(multiply(combine(children[a],negative_value),weight));
      delta.average.push_back(step.policy[a] == 0 || average_weight == -std::numeric_limits<long double>::infinity()
        ? SignedLog{} : SignedLog{1, average_weight + std::log(static_cast<long double>(step.policy[a]))});
    }
    deltas.push_back(std::move(delta));
  }
  // Validate and aggregate the entire episode before committing any updates.
  std::unordered_map<std::string, CfrEntry> changed;
  for (const auto& delta : deltas) {
    auto [it, fresh] = changed.try_emplace(delta.key);
    if (fresh) it->second = table.entries.at(delta.key);
    auto& entry = it->second;
    const auto add = [](std::vector<double>& values, double& scale, size_t action, SignedLog increment) {
      if (!increment.sign) return;
      if (!std::isfinite(increment.magnitude)) throw std::runtime_error("Invalid MCCFR log importance weight");
      if (increment.magnitude > scale) {
        const auto factor = std::exp(static_cast<long double>(scale)-increment.magnitude);
        for (auto& v : values) v = static_cast<double>(v*factor);
        scale = static_cast<double>(increment.magnitude);
      }
      values[action] += increment.sign * static_cast<double>(std::exp(increment.magnitude-scale));
      if (!std::isfinite(values[action])) throw std::runtime_error("Invalid MCCFR accumulator");
    };
    for (size_t a = 0; a < entry.actions.size(); ++a) {
      add(entry.regrets, entry.regret_scale, a, delta.regrets[a]);
      add(entry.strategy_sum, entry.strategy_scale, a, delta.average[a]);
    }
    if(delta.learn_baseline)entry.baseline[delta.selected]=.9*entry.baseline[delta.selected]+.1*delta.target;
  }
  for (auto& [key, entry] : changed) table.entries.at(key) = std::move(entry);
  ++table.episodes;
}

}  // namespace citadels::native
