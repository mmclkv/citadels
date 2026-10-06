#pragma once
#include <array>
#include <cstdint>
#include <string>
#include <vector>
namespace citadels::native {
// Stable SHA-256 history fingerprints, independent of std::hash/platform.
inline std::string cfr_digest(const std::string& input) {
  static constexpr uint32_t constants[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
  std::array<uint32_t,8> h{0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
  std::vector<uint8_t> data(input.begin(), input.end());
  const uint64_t bits = static_cast<uint64_t>(data.size())*8;
  data.push_back(0x80); while (data.size()%64 != 56) data.push_back(0);
  for (int b=7;b>=0;--b) data.push_back(static_cast<uint8_t>(bits>>(b*8)));
  const auto rotate=[](uint32_t x,int n){return (x>>n)|(x<<(32-n));};
  for(size_t offset=0;offset<data.size();offset+=64){
    uint32_t w[64]{};
    for(int i=0;i<16;++i)for(int j=0;j<4;++j)w[i]=(w[i]<<8)|data[offset+i*4+j];
    for(int i=16;i<64;++i){
      const auto s0=rotate(w[i-15],7)^rotate(w[i-15],18)^(w[i-15]>>3);
      const auto s1=rotate(w[i-2],17)^rotate(w[i-2],19)^(w[i-2]>>10);
      w[i]=w[i-16]+s0+w[i-7]+s1;
    }
    auto v=h;
    for(int i=0;i<64;++i){
      const auto t1=v[7]+(rotate(v[4],6)^rotate(v[4],11)^rotate(v[4],25))+
        ((v[4]&v[5])^(~v[4]&v[6]))+constants[i]+w[i];
      const auto t2=(rotate(v[0],2)^rotate(v[0],13)^rotate(v[0],22))+
        ((v[0]&v[1])^(v[0]&v[2])^(v[1]&v[2]));
      for(int j=7;j>0;--j)v[j]=v[j-1]; v[4]+=t1;v[0]=t1+t2;
    }
    for(int i=0;i<8;++i)h[i]+=v[i];
  }
  std::string result;result.reserve(64);
  for(auto x:h)for(int i=7;i>=0;--i)result.push_back("0123456789abcdef"[(x>>(4*i))&15]);
  return result;
}
}
