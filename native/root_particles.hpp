#pragma once

#include <algorithm>
#include <chrono>
#include <cmath>
#include <functional>
#include <limits>
#include <random>
#include <string>
#include <stdexcept>
#include <unordered_map>
#include <utility>
#include <vector>

namespace citadels::native {

// Proposal multiplicity and importance mass are separate: deduplication must
// not turn a common world into an equally likely rare world. Log weights use
// one scale across ALL batches (never normalize each batch independently).
template<class State> class ProgressiveRootParticles {
 public:
  struct Sample { State state; double log_weight = 0; };
  using Generator = std::function<std::vector<Sample>(size_t)>;
  using Identity = std::function<std::string(const State&)>;
  Generator generate;
  Identity identity;
  std::function<void(State&, std::mt19937&)> randomize_chance;
  size_t interval = 32, batch = 4, limit = 1024;
  // Timed callers can throttle expensive scoring by elapsed overhead. Fixed
  // simulation callers keep a deterministic refresh schedule (fraction=1).
  double sampling_fraction = 1;
  double prior_mixture = 0;
  size_t proposals = 0, duplicates = 0, refreshes = 0;
  double sampling_ms = 0;
  std::vector<State> states;
  std::vector<double> weights;

  void add(std::vector<Sample> samples) {
    for (auto& sample : samples) {
      if (std::isnan(sample.log_weight) || sample.log_weight == INFINITY)
        throw std::runtime_error("Invalid root importance weight");
      const auto key = identity ? identity(sample.state) : std::to_string(proposals);
      auto found = indices_.find(key);
      size_t index;
      if (found == indices_.end()) {
        index = states.size(); indices_.emplace(key, index);
        states.push_back(std::move(sample.state)); entries_.push_back({});
      } else { index = found->second; ++duplicates; }
      auto& entry = entries_[index];
      ++entry.count; ++proposals;
      entry.mass = log_add(entry.mass, sample.log_weight);
      entry.square_mass = log_add(entry.square_mass, 2 * sample.log_weight);
    }
    reweight();
  }

  template<class Expired> void refresh(size_t completed, Expired expired) {
    if (!generate || completed < next_refresh_ || proposals >= limit || expired()) return;
    const auto started = std::chrono::steady_clock::now();
    auto samples = generate(std::min(batch, limit - proposals));
    if (samples.empty()) generate = {};
    else add(std::move(samples));
    ++refreshes;
    const auto now=std::chrono::steady_clock::now();
    const double cost=std::chrono::duration<double, std::milli>(now-started).count();
    sampling_ms += cost;
    size_t period=std::max<size_t>(1,interval);
    if(sampling_fraction>0 && sampling_fraction<1 && completed) {
      const double elapsed=std::chrono::duration<double,std::milli>(now-started_).count();
      const double compute_ms=std::max(.001,elapsed-sampling_ms);
      const double required=cost*(1-sampling_fraction)/sampling_fraction*completed/compute_ms;
      period=std::max(period,static_cast<size_t>(std::min(4096.,std::ceil(required))));
    }
    next_refresh_=completed+period;
  }

  State draw(std::mt19937& rng) const {
    State state = states.at(std::discrete_distribution<size_t>(weights.begin(), weights.end())(rng));
    if (randomize_chance) randomize_chance(state, rng);
    return state;
  }

  // ESS over proposals, rather than unique worlds: reports concentration of
  // importance weights. Unique-world count is reported separately.
  double effective_samples() const { return ess_; }

 private:
  struct Entry { size_t count=0; double mass=-INFINITY, square_mass=-INFINITY; };
  std::vector<Entry> entries_;
  std::unordered_map<std::string, size_t> indices_;
  size_t next_refresh_ = 32;
  std::chrono::steady_clock::time_point started_=std::chrono::steady_clock::now();
  double ess_ = 0;
  static double log_add(double a, double b) {
    if (!std::isfinite(a)) return b;
    const double m=std::max(a,b); return m+std::log(std::exp(a-m)+std::exp(b-m));
  }
  void reweight() {
    if (entries_.empty()) return;
    double mass=-INFINITY, squares=-INFINITY;
    for (const auto& e : entries_) { mass=log_add(mass,e.mass); squares=log_add(squares,e.square_mass); }
    if (!std::isfinite(mass)) {
      weights.clear();
      for (const auto& e : entries_) weights.push_back(static_cast<double>(e.count)/proposals);
      ess_=static_cast<double>(proposals);
      return;
    }
    const double mix=std::clamp(prior_mixture,0.,1.);
    weights.clear(); weights.reserve(entries_.size());
    for (const auto& e : entries_)
      weights.push_back((1-mix)*std::exp(e.mass-mass)+mix*e.count/proposals);
    const double sum_squares=(1-mix)*(1-mix)*std::exp(squares-2*mass)+(2*mix-mix*mix)/proposals;
    ess_=1./sum_squares;
  }
};

}  // namespace citadels::native
