const jointTrainsGen = (trains: any) => {
  let finalString = "";

  finalString +=
    "Train Number | Train ID | Railroad | Background Icon Color | Text Icon Color | First Station Code | First Station Name | First Station Time | First Station Time Zone | Next Station Code | Next Station Name | Next Station Time | Next Station Time Zone | Final Station Code | Final Station Name | Final Station Time | Final Station Time Zone | All Stations Array | Speed (mph) | Heading | Last Updated Timestamp | Amtraker URL | JSON Info URL | Markdown Info URL\n";
  finalString += " - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - \n";
  Object.values(trains)
    .flat()
    .forEach((train: any) => {
      const firstStation = train.stations[0];
      const lastStation = train.stations.at(-1);
      const nextStation = train.stations.find((station: any) => station.code == train.eventCode);

      finalString += `${train.trainNum} | ${train.trainID} | ${train.provider} | ${train.iconColor} | ${train.textColor} | ${firstStation.code} | ${firstStation.name} | ${new Date(firstStation.dep ?? firstStation.arr).toISOString()} | ${firstStation.tz} | ${nextStation.code} | ${nextStation.name} | ${new Date(nextStation.dep ?? nextStation.arr).toISOString()} | ${nextStation.tz} | ${lastStation.code} | ${lastStation.name} | ${new Date(lastStation.dep ?? lastStation.arr).toISOString()} | ${lastStation.tz} | ${train.stations.map((station: any) => station.code).join(", ")} | ${train.velocity} | ${train.heading} | ${new Date(train.lastValTS).toISOString()} | https://amtraker.com/trains/${train.trainID.replace("-", "/")} | https://api.amtraker.com/v3/trains/${train.trainID} | https://api.amtraker.com/v3/md/trains/${train.trainID}\n`;
    });

  return finalString;
};

export const generateFromTrains = (trains: any) => {
  const processingStart = Date.now();

  let finalString = "# Amtraker Trains\n\n";
  finalString +=
    "> Below is a list of trains that are currently being tracked by Amtraker and some basic information about them.\n";
  finalString += "> More information about how to use this document is available at https://amtraker.com/llms.txt\n\n";
  finalString += jointTrainsGen(trains);
  finalString += `\n> Markdown took ${Date.now() - processingStart}ms to render`;

  return finalString;
};

export const generateFromTrain = (trains: any, idOrNum: string) => {
  const processingStart = Date.now();

  let finalString = `# Amtraker Train ${idOrNum}\n\n`;
  finalString +=
    "> Below is a list of trains that are currently being tracked by Amtraker that match the requested train train number/id and some basic information about it/them.\n";
  finalString += "> More information about how to use this document is available at https://amtraker.com/llms.txt\n\n";
  finalString += jointTrainsGen(trains);
  finalString += "\n\n## Detailed Stop Data\n\n";
  finalString +=
    "> The following data is only for train timings at each stop. For basic train data, consult the table above.\n\n";

  trains.forEach((train: any) => {
    console.log(train);
    finalString += `### Train ${train.trainID}\n`;
    finalString +=
      "Stop Order | Stop Code | Stop Name | Stop Time Zone | Scheduled Arrival | Scheduled Departure | Estimated/Actual Arrival | Estimated/Actual Departure | Train Status to Stop | Platform Number\n";
    finalString += " - | - | - | - | - | - | - | - | - | - \n";
    train.stations.forEach((station: any, i) => {
      finalString += `${i + 1} | ${station.code} | ${station.name} | ${station.tz} | ${new Date(station.schArr).toISOString()} | ${new Date(station.schDep).toISOString()} | ${new Date(station.arr).toISOString()} | ${new Date(station.dep).toISOString()} | ${station.status} | ${station.platform}\n`;
    });
  });

  finalString += `\n> Markdown took ${Date.now() - processingStart}ms to render`;

  return finalString;
};

export const generateFromStations = (stations: any) => {
  const processingStart = Date.now();

  let finalString = `# Amtraker Stations\n\n`;
  finalString +=
    "> Below is a list of stations that are currently in Amtraker's database and some basic information about them.\n";
  finalString += "> More information about how to use this document is available at https://amtraker.com/llms.txt\n\n";
  finalString +=
    "Station Code | Station Name | Station Time Zone | Tracked Train IDs | Station Latitude | Station Longitude | Has Address? | Address1 | Address2	| City | State | Zip | Amtraker URL | JSON Info URL | Markdown Info URL\n";
  finalString += " - | - | - | - | - | - | - | - | - | - | - | - | - | - | - \n";

  Object.values(stations).forEach((station: any) => {
    finalString += `${station.code} | ${station.name} | ${station.tz} | ${station.trains.join(", ")} | ${station.trains.map((trainID: string) => `https://api.amtraker.com/v3/md/trains/${trainID}`).join(", ")} | ${station.lat} | ${station.lon} | ${station.hasAddress} | ${station.address1} | ${station.address2} | ${station.city} | ${station.state} | ${station.zip} | https://amtraker.com/stations/${station.code} | https://api.amtraker.com/v3/stations/${station.code} | https://api.amtraker.com/v3/md/stations/${station.code}\n`;
  });

  finalString += '\nFor more information about each train, use the provided URLs (if any) within the above table to then fetch Markdown about each train.\n\n'

  finalString += `\n> Markdown took ${Date.now() - processingStart}ms to render`;

  return finalString;
};
export const generateFromStation = (station: any) => {
  const processingStart = Date.now();

  let finalString = `# Amtraker ${station.name}Station (${station.code})\n\n`;
  finalString += `> Below is a information about ${station.name} station (${station.code}) stations that is currently in Amtraker\'s database and some basic information about it.\n`;
  finalString += "> More information about how to use this document is available at https://amtraker.com/llms.txt\n\n";
  finalString += "## Basic Station Info\n\n";
  finalString +=
    "Station Code | Station Name | Station Time Zone | Tracked Train IDs | Tracked Train Markdown URLs | Station Latitude | Station Longitude | Has Address? | Address1 | Address2	| City | State | Zip | Amtraker URL | JSON Info URL | Markdown Info URL\n";
  finalString += " - | - | - | - | - | - | - | - | - | - | - | - | - | - | - | - \n";
  finalString += `${station.code} | ${station.name} | ${station.tz} | ${station.trains.join(", ")} | ${station.trains.map((trainID: string) => `https://api.amtraker.com/v3/md/trains/${trainID}`).join(", ")} | ${station.lat} | ${station.lon} | ${station.hasAddress} | ${station.address1} | ${station.address2} | ${station.city} | ${station.state} | ${station.zip} | https://amtraker.com/stations/${station.code} | https://api.amtraker.com/v3/stations/${station.code} | https://api.amtraker.com/v3/md/stations/${station.code}\n`;

  finalString += '## Train Info\n\n'
  finalString += 'For more information about each train, use the provided URLs (if any) to fetch Markdown/JSON about each train.\n\n'
  finalString += 'Train ID | Markdown URL | JSON URL\n';
  finalString += '- | - | -\n';
  
  station.trains.forEach((trainID: any) => {
    finalString += `${trainID} | https://api.amtraker.com/v3/md/trains/${trainID} | https://api.amtraker.com/v3/trains/${trainID}\n`
  })

  finalString += `\n> Markdown took ${Date.now() - processingStart}ms to render`;

  return finalString;
};
