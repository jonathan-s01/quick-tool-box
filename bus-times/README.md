# Bus times

A small page for Edmonton Transit Service (ETS) bus stops. It only works for Edmonton. For each stop it shows the next 25 buses with the scheduled time and the live estimated time.

- Save stops and give them nicknames. Saved stops are kept on the server, so your phone and Mac share the same list.
- Find stops by stop number, by name (for example "jasper 108"), by address or place, or near you.
- Look up a route number to see every stop on it, in each direction.
- Look ahead to any date and time.
- Times refresh every 30 seconds while the page is open (you can turn this off). The page shows how long ago the times were updated, and has a Refresh times button.
- Buses only. LRT is left out.

## Start it

It is part of the Quick Tool Box docker-compose stack, in its own group, bus. Answer yes when ./setup.sh asks about Bus times, or add bus to COMPOSE_PROFILES in .env (for example llm,apps,bus) and run ./setup.sh again.

The first start downloads the ETS schedule, which takes about a minute. Until then the page says the schedule is still loading. After that it checks once a day for a new schedule and keeps a copy, so restarts are quick.

Check it is working: http://SERVER:3220

## Who can connect

The page has no login. It only answers addresses in ALLOWED_NETWORKS in .env, the same setting Quick Tool Box uses. Only make it reachable on your home network and VPN, never from the internet.

## A name and https (optional)

To use a name such as bus.example.com, put a reverse proxy in front of it. With Caddy, add this to your Caddyfile, then reload Caddy:

    bus.example.com {
        reverse_proxy SERVER-IP:3220
    }

Use localhost:3220 if Caddy runs on the same computer. Make sure your local DNS (for example your router, AdGuard or Pi-hole) points the name at Caddy, and that Caddy's own address is inside ALLOWED_NETWORKS.

"Stops near me" needs the https address. Browsers only share location with secure pages.

On iPhone, open the https address in Safari, choose Share, then Add to Home Screen. It then opens like an app.

## Stop directions (EB, WB, NB, SB)

The ETS data does not include stop directions, so the page works them out:

- ETS names stops "street the stop is on & cross street". In Edmonton, Streets run north and south, and Avenues run east and west.
- The page also checks which way buses go into and out of the stop.
- When both agree, the label has no star, for example "109 Street & Jasper Avenue NB".
- When they don't agree, the label ends with a star, for example "WB*". This happens at the first stop of a route, or when buses turn right after the stop.
- Transit centre stops show their bay instead, for example "Abbottsfield Transit Centre, bay A".

## Data

- Schedule: https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/GTFS/gtfs.zip
- Live estimates: https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/TripUpdate/TripUpdates.pb
- Address search: OpenStreetMap (Nominatim), limited to the Edmonton area. Only the address or place you type is sent. Searches are limited to one a second and recent answers are reused, as OpenStreetMap's usage policy asks. Map data © OpenStreetMap contributors, available under the Open Database License.
- Schedule and live times are open data from the City of Edmonton, under its open data terms of use. This page is not made or endorsed by the City of Edmonton or ETS.

How estimates work: if the live feed has a time for your stop, that is used. Otherwise the bus's lateness at its last reported stop is carried forward. "No estimate" means the live feed has nothing for that bus yet, which is common for buses that haven't started their trip. Buses that end at a stop are not listed there, because you can't board them.

## Settings (optional)

Environment variables: PORT (3220), DATA_DIR (/data), ALLOWED_NETWORKS, GTFS_URL, TRIP_UPDATES_URL, GEOCODE_URL (another Nominatim server) and USER_AGENT. In .env, BUS_PORT changes the port on the server.

Memory: about 250 MB while loading the schedule, less after.
