interface StationReplacement {
  [key: string]: string;
}

export const amtrakStationCodeReplacements: StationReplacement = {
  TWO: "TRTO",
  OKL: "OAKV",
  AST: "ALDR",
  GMS: "GRIM",
  SCA: "SCAT",
  NFS: "NIAG",
  MTR: "MTRL",
  SLQ: "SLAM",
  VAC: "VCVR",
};

export const viaStationInfoReplacements: StationReplacement = {
  TRTO: "TWO",
  OAKV: "OKL",
  ALDR: "AST",
  GRIM: "GMS",
  SCAT: "SCA",
  NIAG: "NFS",
  MTRL: "MTR",
  SLAM: "SLQ",
  VCVR: "VAC",
};
