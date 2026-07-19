import { expect, test, describe } from "bun:test";
import Cache from "./cache";

describe("cache.setTrains resilience", () => {
  test("a malformed train (empty stations[]) does not block other trains from being committed", () => {
    const c = new Cache();
    const data: any = {
      "123": [{
        trainNum: "123",
        trainID: "123-1",
        stations: [
          { code: "NYP", schDep: "2026-07-19T10:00:00-04:00", tz: "America/New_York" },
        ],
      }],
      "999": [{
        trainNum: "999",
        trainID: "999-1",
        stations: [],
      }],
    };

    expect(() => c.setTrains(data)).not.toThrow();
    expect(c.getIDs()).toContain("123-7-19-26");
    expect(Object.keys(c.getTrains())).toEqual(["123", "999"]);
  });

  test("a bad timezone string on one train does not block others", () => {
    const c = new Cache();
    const data: any = {
      "1": [{
        trainNum: "1",
        trainID: "1-1",
        stations: [{ code: "CHI", schDep: "2026-07-19T08:00:00-05:00", tz: "America/Chicago" }],
      }],
      "2": [{
        trainNum: "2",
        trainID: "2-1",
        stations: [{ code: "LAX", schDep: "2026-07-19T08:00:00-08:00", tz: "Not/A_Real_Timezone" }],
      }],
    };

    expect(() => c.setTrains(data)).not.toThrow();
    expect(c.getIDs().length).toBe(1);
    expect(c.getIDs()[0]).toContain("1-");
  });

  test("setStation does not write a phantom entry for a station that doesn't exist yet", () => {
    const c = new Cache();
    const data: any = {
      "5": [{
        trainNum: "5",
        trainID: "5-1",
        stations: [{ code: "CHI", schDep: "2026-07-19T08:00:00-05:00", tz: "America/Chicago" }],
      }],
    };

    c.setTrains(data);
    expect("CHI" in c.getStations()).toBe(false);
    expect(c.stationExists("CHI")).toBe(false);
  });

  test("existing station records still get correctly annotated with train IDs", () => {
    const c = new Cache();
    c.setStations({
      "NYP": { code: "NYP", name: "New York Penn", trains: [] } as any,
    });

    const data: any = {
      "123": [{
        trainNum: "123",
        trainID: "123-1",
        stations: [{ code: "NYP", schDep: "2026-07-19T10:00:00-04:00", tz: "America/New_York" }],
      }],
    };

    c.setTrains(data);
    expect(c.getStation("NYP").trains).toContain("123-1");
  });

  test("does not duplicate a train ID already recorded on a station", () => {
    const c = new Cache();
    c.setStations({
      "NYP": { code: "NYP", name: "New York Penn", trains: ["123-1"] } as any,
    });

    const data: any = {
      "123": [{
        trainNum: "123",
        trainID: "123-1",
        stations: [{ code: "NYP", schDep: "2026-07-19T10:00:00-04:00", tz: "America/New_York" }],
      }],
    };

    c.setTrains(data);
    expect(c.getStation("NYP").trains.filter((id: string) => id === "123-1").length).toBe(1);
  });
});
