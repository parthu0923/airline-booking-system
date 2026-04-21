const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const { MongoClient } = require('mongodb');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// MongoDB Atlas Connection
const MONGO_URI = 'mongodb+srv://parthu:parthu123@cluster0.tqtiw0q.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const DB_NAME = 'airline_db';
let db;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'airline-booking-secret-2024',
    resave: false,
    saveUninitialized: true
}));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// HELPER FUNCTIONS
// ============================================

async function getNextId(collectionName) {
    const result = await db.collection('counters').findOneAndUpdate(
        { _id: collectionName },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' }
    );
    return result.seq;
}

// Dynamic pricing - days until departure
function getDateMultiplier(daysUntil) {
    if (daysUntil <= 0) return 2.5;
    if (daysUntil <= 3) return 2.2;
    if (daysUntil <= 7) return 1.8;
    if (daysUntil <= 15) return 1.5;
    if (daysUntil <= 30) return 1.2;
    return 1.0;
}

// Dynamic pricing - seat availability
function getAvailabilityMultiplier(bookedSeats, totalSeats) {
    if (totalSeats <= 0) return 1.0;
    const available = (totalSeats - bookedSeats) / totalSeats;
    if (available > 0.7) return 1.0;
    if (available > 0.5) return 1.1;
    if (available > 0.3) return 1.25;
    return 1.4;
}

// ============================================
// LOGIN
// ============================================

app.post('/LoginServlet', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await db.collection('users').findOne({ username, password });

        if (user) {
            req.session.userId = user.id;
            req.session.username = user.username;
            res.json({ success: true, userId: user.id, username: user.username });
        } else {
            res.json({ success: false, message: 'Invalid username or password' });
        }
    } catch(e) {
        console.error(e);
        res.json({ success: false, message: 'Server error: ' + e.message });
    }
});

// ============================================
// REGISTER
// ============================================

app.post('/RegisterServlet', async (req, res) => {
    try {
        const { username, password, email, phone } = req.body;

        const existing = await db.collection('users').findOne({ username });
        if (existing) {
            return res.json({ success: false, message: 'Username already exists' });
        }

        const id = await getNextId('users');
        await db.collection('users').insertOne({
            id, username, password, email, phone,
            created_at: new Date()
        });

        res.json({ success: true, message: 'Registration successful' });
    } catch(e) {
        console.error(e);
        res.json({ success: false, message: 'Registration failed: ' + e.message });
    }
});

// ============================================
// FLIGHT SEARCH
// ============================================

app.get('/FlightServlet', async (req, res) => {
    try {
        const from = req.query.from;
        const to = req.query.to;
        const dateStr = req.query.date;
        const seatClass = req.query.seatClass || 'economy';

        // Calculate days until departure
        const departureDate = new Date(dateStr);
        const today = new Date();
        const daysUntil = Math.ceil((departureDate - today) / (1000 * 60 * 60 * 24));
        const dateMultiplier = getDateMultiplier(daysUntil);

        // Search direct flights
        const flights = await db.collection('flights').find({
            source: from, destination: to, status: 'active'
        }).toArray();

        const flightsResult = [];
        for (const flight of flights) {
            const bookedCount = await db.collection('booked_seats').countDocuments({
                flight_id: flight.id, flight_date: dateStr
            });

            const availMultiplier = getAvailabilityMultiplier(bookedCount, flight.total_seats);
            const basePrice = seatClass === 'business' ? flight.base_price_business : flight.base_price_economy;
            const dynamicPrice = Math.round(basePrice * dateMultiplier * availMultiplier);

            flightsResult.push({
                id: flight.id,
                flightNumber: flight.flight_number,
                airline: flight.airline,
                departureTime: flight.departure_time,
                arrivalTime: flight.arrival_time,
                duration: flight.duration_mins,
                price: dynamicPrice,
                basePrice: basePrice,
                aircraft: flight.aircraft,
                totalSeats: flight.total_seats,
                bookedSeats: bookedCount,
                priceMultiplier: (dateMultiplier * availMultiplier).toFixed(1)
            });
        }

        const connectingFlights = await db.collection('connecting_flights').find().toArray();
        const connectingResult = [];

        for (const cf of connectingFlights) {
            const f1 = await db.collection('flights').findOne({ id: cf.flight1_id });
            const f2 = await db.collection('flights').findOne({ id: cf.flight2_id });

            if (!f1 || !f2) continue;
            if (f1.source !== from || f2.destination !== to) continue;

            const f1Price = seatClass === 'business' ? f1.base_price_business : f1.base_price_economy;
            const f2Price = seatClass === 'business' ? f2.base_price_business : f2.base_price_economy;
            const combinedBase = f1Price + f2Price;

            const cheapestDirect = flightsResult.length > 0
                ? Math.min(...flightsResult.map(fl => fl.price))
                : Math.round(combinedBase * dateMultiplier);

            const discountFactor = 0.5 + Math.random() * 0.3;
            const finalPrice = Math.round(cheapestDirect * discountFactor);
            const totalDuration = f1.duration_mins + f2.duration_mins + cf.layover_minutes;

            connectingResult.push({
                routeName: cf.route_name,
                flight1Number: f1.flight_number,
                flight2Number: f2.flight_number,
                departureTime: f1.departure_time,
                arrivalTime: f2.arrival_time,
                via: f1.destination,
                layoverMins: cf.layover_minutes,
                totalDuration: totalDuration,
                price: finalPrice
            });
        }

        res.json({ flights: flightsResult, connecting: connectingResult });
    } catch(e) {
        console.error(e);
        res.json({ flights: [], connecting: [], error: e.message });
    }
});

// ============================================
// SEAT SERVLET
// ============================================

app.get('/SeatServlet', async (req, res) => {
    try {
        const flightId = parseInt(req.query.flightId);
        const date = req.query.date;

        const seats = await db.collection('booked_seats').find({
            flight_id: flightId, flight_date: date
        }).toArray();

        const bookedSeats = seats.map(s => s.seat_number);
        res.json({ bookedSeats });
    } catch(e) {
        console.error(e);
        res.json({ bookedSeats: [] });
    }
});

app.post('/SeatServlet', async (req, res) => {
    res.json({ success: true });
});

// ============================================
// PASSENGER SERVLET
// ============================================

app.post('/PassengerServlet', async (req, res) => {
    res.json({ success: true });
});

// ============================================
// PAYMENT / BOOKING
// ============================================

app.post('/PaymentServlet', async (req, res) => {
    try {
        let userId = 1;
        try { userId = parseInt(req.body.userId) || 1; } catch(e) {}

        const flightId = parseInt(req.body.flightId);
        const flightDate = req.body.flightDate;
        const seatClass = req.body.seatClass;
        const totalAmount = parseFloat(req.body.totalAmount);
        const passengersJson = req.body.passengers;
        const seatsJson = req.body.seats;

        // Generate PNR
        const pnr = 'SW' + String(Math.floor(Math.random() * 999999)).padStart(6, '0');

        // Create booking
        const bookingId = await getNextId('bookings');
        await db.collection('bookings').insertOne({
            id: bookingId,
            user_id: userId,
            flight_id: flightId,
            flight_date: flightDate,
            seat_class: seatClass,
            booking_date: new Date(),
            total_amount: totalAmount,
            pnr: pnr,
            status: 'confirmed'
        });

        // Parse and store passengers
        if (passengersJson) {
            let seatNumbers = [];
            if (seatsJson) {
                seatNumbers = seatsJson.replace(/[\[\]"]/g, '').split(',').map(s => s.trim());
            }

            const passengerParts = passengersJson.split('},{');
            for (let i = 0; i < passengerParts.length; i++) {
                let p = passengerParts[i].replace(/[\[\]{}]/g, '');

                const getName = (s) => {
                    const m = s.match(/"name":"([^"]*)"/);
                    return m ? m[1] : '';
                };
                const getPhone = (s) => {
                    const m = s.match(/"phone":"([^"]*)"/);
                    return m ? m[1] : '';
                };
                const getEmail = (s) => {
                    const m = s.match(/"email":"([^"]*)"/);
                    return m ? m[1] : '';
                };

                const name = getName(p);
                const phone = getPhone(p);
                const email = getEmail(p);
                const seatNumber = i < seatNumbers.length ? seatNumbers[i] : '';

                const passengerId = await getNextId('passengers');
                await db.collection('passengers').insertOne({
                    id: passengerId,
                    booking_id: bookingId,
                    name, phone, email,
                    seat_number: seatNumber
                });

                // Book the seat
                if (seatNumber) {
                    try {
                        await db.collection('booked_seats').insertOne({
                            flight_id: flightId,
                            flight_date: flightDate,
                            seat_number: seatNumber,
                            booking_id: bookingId
                        });
                    } catch(e) {
                        // Seat already booked (duplicate key)
                    }
                }
            }
        }

        res.json({ success: true, pnr: pnr, bookingId: bookingId });
    } catch(e) {
        console.error(e);
        res.json({ success: false, message: 'Payment processing failed: ' + e.message });
    }
});

// ============================================
// ADMIN
// ============================================

app.get('/AdminServlet', async (req, res) => {
    try {
        const action = req.query.action;

        if (action === 'stats') {
            const totalFlights = await db.collection('flights').countDocuments();
            const totalBookings = await db.collection('bookings').countDocuments();
            const totalUsers = await db.collection('users').countDocuments();

            const bookings = await db.collection('bookings').find().toArray();
            let totalRevenue = 0;
            for (const b of bookings) {
                totalRevenue += (typeof b.total_amount === 'number' ? b.total_amount : 0);
            }

            res.json({ totalFlights, totalBookings, totalUsers, totalRevenue });

        } else if (action === 'allFlights') {
            const flights = await db.collection('flights').find().sort({ id: -1 }).toArray();
            const result = flights.map(f => ({
                id: f.id,
                flightNumber: f.flight_number,
                airline: f.airline,
                source: f.source,
                destination: f.destination,
                departureTime: f.departure_time,
                arrivalTime: f.arrival_time,
                basePriceEconomy: f.base_price_economy,
                basePriceBusiness: f.base_price_business,
                totalSeats: f.total_seats,
                aircraft: f.aircraft
            }));
            res.json({ flights: result });

        } else if (action === 'bookings') {
            const bookings = await db.collection('bookings').find().sort({ id: -1 }).toArray();
            const result = bookings.map(b => ({
                id: b.id,
                flightId: b.flight_id,
                flightDate: b.flight_date,
                seatClass: b.seat_class,
                totalAmount: typeof b.total_amount === 'number' ? b.total_amount : 0,
                pnr: b.pnr,
                status: b.status
            }));
            res.json({ bookings: result });
        }
    } catch(e) {
        console.error(e);
        res.json({ error: e.message });
    }
});

app.post('/AdminServlet', async (req, res) => {
    const action = req.body.action;

    if (action === 'login') {
        const { username, password } = req.body;
        if (username === 'admin' && password === 'admin123') {
            req.session.admin = true;
            return res.json({ success: true });
        } else {
            return res.json({ success: false, message: 'Invalid admin credentials' });
        }
    }

    try {
        if (action === 'add') {
            const id = await getNextId('flights');
            await db.collection('flights').insertOne({
                id,
                flight_number: req.body.flightNumber,
                airline: req.body.airline,
                source: req.body.source,
                destination: req.body.destination,
                departure_time: req.body.departureTime,
                arrival_time: req.body.arrivalTime,
                duration_mins: parseInt(req.body.duration),
                base_price_economy: parseFloat(req.body.basePriceEconomy),
                base_price_business: parseFloat(req.body.basePriceBusiness),
                total_seats: parseInt(req.body.totalSeats),
                aircraft: req.body.aircraft,
                status: 'active'
            });
            res.json({ success: true, message: 'Flight added successfully' });

        } else if (action === 'delete') {
            const flightId = parseInt(req.body.flightId);
            await db.collection('flights').deleteOne({ id: flightId });
            res.json({ success: true, message: 'Flight deleted' });

        } else if (action === 'update') {
            const flightId = parseInt(req.body.flightId);
            await db.collection('flights').updateOne(
                { id: flightId },
                { $set: { source: req.body.source, destination: req.body.destination } }
            );
            res.json({ success: true, message: 'Flight updated' });
        }
    } catch(e) {
        console.error(e);
        res.json({ success: false, message: 'Error: ' + e.message });
    }
});

// ============================================
// CAB BOOKING
// ============================================

app.get('/CabServlet', async (req, res) => {
    try {
        const poolingCount = await db.collection('cab_bookings').countDocuments({ is_pooling: 1 });
        const recentPooling = await db.collection('cab_bookings').find({ is_pooling: 1 }).sort({ _id: -1 }).limit(5).toArray();
        const poolingDetails = recentPooling.map(p => ({
            pickup: p.pickup_location,
            drop: p.drop_location,
            cabType: p.cab_type
        }));
        res.json({ poolingCount, poolingDetails });
    } catch(e) {
        res.json({ poolingCount: 0, poolingDetails: [] });
    }
});

app.post('/CabServlet', async (req, res) => {
    try {
        let bookingId = 0;
        try { bookingId = parseInt(req.body.bookingId) || 0; } catch(e) {}

        const id = await getNextId('cab_bookings');
        await db.collection('cab_bookings').insertOne({
            id,
            booking_id: bookingId,
            pickup_location: req.body.pickup,
            drop_location: req.body.drop,
            cab_type: req.body.cabType,
            is_pooling: req.body.isPooling === '1' ? 1 : 0,
            booking_date: req.body.bookingDate,
            amount: parseFloat(req.body.amount),
            status: 'confirmed'
        });

        res.json({ success: true, message: 'Cab booked successfully' });
    } catch(e) {
        console.error(e);
        res.json({ success: true, message: 'Cab booked' });
    }
});

// ============================================
// HOTEL BOOKING
// ============================================

app.post('/HotelServlet', async (req, res) => {
    try {
        let bookingId = 0;
        try { bookingId = parseInt(req.body.bookingId) || 0; } catch(e) {}

        const id = await getNextId('hotel_bookings');
        await db.collection('hotel_bookings').insertOne({
            id,
            booking_id: bookingId,
            hotel_name: req.body.hotelName,
            room_type: req.body.roomType,
            checkin_date: req.body.checkin,
            checkout_date: req.body.checkout,
            amount: parseFloat(req.body.amount),
            status: 'confirmed'
        });

        res.json({ success: true, message: 'Hotel booked successfully' });
    } catch(e) {
        console.error(e);
        res.json({ success: true, message: 'Hotel booked' });
    }
});

// ============================================
// DATA INITIALIZATION (runs on startup)
// ============================================

async function initializeData() {
    console.log('=== Checking MongoDB data ===');

    // Create unique index on booked_seats
    try {
        await db.collection('booked_seats').createIndex(
            { flight_id: 1, flight_date: 1, seat_number: 1 },
            { unique: true }
        );
    } catch(e) { /* index may already exist */ }

    // Create unique index on usernames
    try {
        await db.collection('users').createIndex(
            { username: 1 },
            { unique: true }
        );
    } catch(e) { /* index may already exist */ }

    const flightCount = await db.collection('flights').countDocuments();
    const cfCount_check = await db.collection('connecting_flights').countDocuments();
    if (flightCount >= 53 && cfCount_check >= 6) {
        console.log('Data already initialized. Skipping seed.');
        return;
    }

    // Drop old data to re-seed cleanly
    console.log('Seeding sample data (clearing old data first)...');
    try { await db.collection('flights').drop(); } catch(e) { /* may not exist */ }
    try { await db.collection('connecting_flights').drop(); } catch(e) { /* may not exist */ }

    // Initialize counters
    const counters = ['users', 'flights', 'bookings', 'passengers', 'cab_bookings', 'hotel_bookings', 'connecting_flights'];
    const counterValues = { users: 2, flights: 53, bookings: 0, passengers: 0, cab_bookings: 0, hotel_bookings: 0, connecting_flights: 6 };
    for (const name of counters) {
        try {
            await db.collection('counters').insertOne({ _id: name, seq: counterValues[name] });
        } catch(e) { /* might exist */ }
    }

    // Seed Users
    try {
        await db.collection('users').insertMany([
            { id: 1, username: 'admin', password: 'admin123', email: 'admin@skywings.com', phone: '9999999999', created_at: new Date() },
            { id: 2, username: 'user1', password: 'pass123', email: 'user1@gmail.com', phone: '9876543210', created_at: new Date() }
        ]);
    } catch(e) { /* users may already exist */ }

    // Seed Flights
    function flight(id, num, airline, src, dest, dep, arr, dur, eco, biz, aircraft) {
        return { id, flight_number: num, airline, source: src, destination: dest,
                 departure_time: dep, arrival_time: arr, duration_mins: dur,
                 base_price_economy: eco, base_price_business: biz,
                 total_seats: 180, aircraft, status: 'active' };
    }

    try {
        await db.collection('flights').insertMany([
            // Delhi to Mumbai
            flight(1, '6E-2001', 'IndiGo', 'Delhi', 'Mumbai', '06:00', '08:10', 130, 3500, 8500, 'Airbus A320'),
            flight(2, 'AI-101', 'Air India', 'Delhi', 'Mumbai', '09:30', '11:45', 135, 4200, 11000, 'Boeing 737'),
            flight(3, 'SG-401', 'SpiceJet', 'Delhi', 'Mumbai', '14:00', '16:15', 135, 2800, 7200, 'Boeing 737 MAX'),
            // Mumbai to Delhi
            flight(4, '6E-2002', 'IndiGo', 'Mumbai', 'Delhi', '07:00', '09:10', 130, 3500, 8500, 'Airbus A320'),
            flight(5, 'AI-102', 'Air India', 'Mumbai', 'Delhi', '12:00', '14:15', 135, 4200, 11000, 'Boeing 737'),
            flight(6, 'SG-402', 'SpiceJet', 'Mumbai', 'Delhi', '18:00', '20:15', 135, 2800, 7200, 'Boeing 737 MAX'),
            // Mumbai to Bangalore
            flight(7, '6E-3001', 'IndiGo', 'Mumbai', 'Bangalore', '08:00', '09:45', 105, 3200, 7800, 'Airbus A320'),
            flight(8, 'UK-801', 'Vistara', 'Mumbai', 'Bangalore', '11:00', '12:50', 110, 5500, 13000, 'Airbus A320neo'),
            flight(9, 'SG-501', 'SpiceJet', 'Mumbai', 'Bangalore', '16:30', '18:20', 110, 2600, 6500, 'Boeing 737'),
            // Bangalore to Mumbai
            flight(10, '6E-3002', 'IndiGo', 'Bangalore', 'Mumbai', '06:30', '08:15', 105, 3200, 7800, 'Airbus A320'),
            flight(11, 'UK-802', 'Vistara', 'Bangalore', 'Mumbai', '14:00', '15:50', 110, 5500, 13000, 'Airbus A320neo'),
            // Delhi to Bangalore
            flight(12, 'AI-501', 'Air India', 'Delhi', 'Bangalore', '07:00', '09:45', 165, 5200, 14000, 'Boeing 787'),
            flight(13, '6E-4001', 'IndiGo', 'Delhi', 'Bangalore', '13:00', '15:50', 170, 4800, 12000, 'Airbus A321'),
            // Bangalore to Delhi
            flight(14, 'AI-502', 'Air India', 'Bangalore', 'Delhi', '10:00', '12:45', 165, 5200, 14000, 'Boeing 787'),
            flight(15, '6E-4002', 'IndiGo', 'Bangalore', 'Delhi', '17:00', '19:50', 170, 4800, 12000, 'Airbus A321'),
            // Bangalore to Chennai
            flight(16, '6E-5001', 'IndiGo', 'Bangalore', 'Chennai', '08:00', '09:00', 60, 2200, 5500, 'ATR 72'),
            flight(17, 'AI-301', 'Air India', 'Bangalore', 'Chennai', '15:00', '16:00', 60, 2800, 7000, 'Airbus A320'),
            // Chennai to Bangalore
            flight(18, '6E-5002', 'IndiGo', 'Chennai', 'Bangalore', '10:00', '11:00', 60, 2200, 5500, 'ATR 72'),
            flight(19, 'AI-302', 'Air India', 'Chennai', 'Bangalore', '17:00', '18:00', 60, 2800, 7000, 'Airbus A320'),
            // Hyderabad to Delhi
            flight(20, '6E-6001', 'IndiGo', 'Hyderabad', 'Delhi', '06:00', '08:15', 135, 3800, 9500, 'Airbus A320'),
            flight(21, 'SG-601', 'SpiceJet', 'Hyderabad', 'Delhi', '11:00', '13:20', 140, 3000, 7500, 'Boeing 737'),
            // Delhi to Hyderabad
            flight(22, '6E-6002', 'IndiGo', 'Delhi', 'Hyderabad', '09:00', '11:15', 135, 3800, 9500, 'Airbus A320'),
            flight(23, 'SG-602', 'SpiceJet', 'Delhi', 'Hyderabad', '16:00', '18:20', 140, 3000, 7500, 'Boeing 737'),
            // Kolkata to Delhi
            flight(24, 'AI-201', 'Air India', 'Kolkata', 'Delhi', '07:00', '09:30', 150, 4500, 11500, 'Boeing 737'),
            flight(25, '6E-7001', 'IndiGo', 'Kolkata', 'Delhi', '14:00', '16:30', 150, 3600, 9000, 'Airbus A320'),
            // Delhi to Kolkata
            flight(26, 'AI-202', 'Air India', 'Delhi', 'Kolkata', '10:00', '12:30', 150, 4500, 11500, 'Boeing 737'),
            flight(27, '6E-7002', 'IndiGo', 'Delhi', 'Kolkata', '17:00', '19:30', 150, 3600, 9000, 'Airbus A320'),
            // Hyderabad to Mumbai
            flight(28, '6E-8001', 'IndiGo', 'Hyderabad', 'Mumbai', '07:30', '09:00', 90, 3000, 7500, 'Airbus A320'),
            flight(29, 'AI-401', 'Air India', 'Hyderabad', 'Mumbai', '14:00', '15:30', 90, 3500, 8500, 'Boeing 737'),
            // Mumbai to Hyderabad
            flight(30, '6E-8002', 'IndiGo', 'Mumbai', 'Hyderabad', '08:00', '09:30', 90, 3000, 7500, 'Airbus A320'),
            flight(31, 'AI-402', 'Air India', 'Mumbai', 'Hyderabad', '16:00', '17:30', 90, 3500, 8500, 'Boeing 737'),
            // Hyderabad to Bangalore
            flight(32, '6E-9001', 'IndiGo', 'Hyderabad', 'Bangalore', '06:30', '07:45', 75, 2800, 7000, 'Airbus A320'),
            flight(33, 'SG-701', 'SpiceJet', 'Hyderabad', 'Bangalore', '13:00', '14:15', 75, 2400, 6000, 'Boeing 737'),
            // Bangalore to Hyderabad
            flight(34, '6E-9002', 'IndiGo', 'Bangalore', 'Hyderabad', '09:00', '10:15', 75, 2800, 7000, 'Airbus A320'),
            flight(35, 'SG-702', 'SpiceJet', 'Bangalore', 'Hyderabad', '16:00', '17:15', 75, 2400, 6000, 'Boeing 737'),
            // Chennai to Delhi
            flight(36, 'AI-601', 'Air India', 'Chennai', 'Delhi', '06:00', '08:50', 170, 5000, 13000, 'Boeing 787'),
            flight(37, '6E-1001', 'IndiGo', 'Chennai', 'Delhi', '14:00', '16:50', 170, 4500, 11500, 'Airbus A321'),
            // Delhi to Chennai
            flight(38, 'AI-602', 'Air India', 'Delhi', 'Chennai', '08:00', '10:50', 170, 5000, 13000, 'Boeing 787'),
            flight(39, '6E-1002', 'IndiGo', 'Delhi', 'Chennai', '15:00', '17:50', 170, 4500, 11500, 'Airbus A321'),
            // Chennai to Hyderabad
            flight(40, '6E-1101', 'IndiGo', 'Chennai', 'Hyderabad', '08:00', '09:15', 75, 2600, 6500, 'Airbus A320'),
            // Hyderabad to Chennai
            flight(41, 'SG-801', 'SpiceJet', 'Hyderabad', 'Chennai', '10:00', '11:15', 75, 2600, 6500, 'Boeing 737'),
            // Mumbai to Chennai
            flight(42, 'AI-701', 'Air India', 'Mumbai', 'Chennai', '07:00', '09:00', 120, 3800, 9500, 'Boeing 737'),
            flight(43, '6E-1201', 'IndiGo', 'Mumbai', 'Chennai', '15:00', '17:00', 120, 3200, 8000, 'Airbus A320'),
            // Chennai to Mumbai
            flight(44, 'AI-702', 'Air India', 'Chennai', 'Mumbai', '09:00', '11:00', 120, 3800, 9500, 'Boeing 737'),
            flight(45, '6E-1202', 'IndiGo', 'Chennai', 'Mumbai', '17:00', '19:00', 120, 3200, 8000, 'Airbus A320'),
            // Kolkata to Mumbai
            flight(46, 'AI-801', 'Air India', 'Kolkata', 'Mumbai', '06:00', '08:45', 165, 5000, 12500, 'Boeing 787'),
            flight(47, '6E-1301', 'IndiGo', 'Kolkata', 'Mumbai', '13:00', '15:45', 165, 4200, 10500, 'Airbus A321'),
            // Mumbai to Kolkata
            flight(48, 'AI-802', 'Air India', 'Mumbai', 'Kolkata', '10:00', '12:45', 165, 5000, 12500, 'Boeing 787'),
            flight(49, '6E-1302', 'IndiGo', 'Mumbai', 'Kolkata', '18:00', '20:45', 165, 4200, 10500, 'Airbus A321'),
            // Kolkata to Bangalore
            flight(50, 'AI-901', 'Air India', 'Kolkata', 'Bangalore', '07:00', '09:45', 165, 5200, 13000, 'Boeing 787'),
            // Bangalore to Kolkata
            flight(51, '6E-1401', 'IndiGo', 'Bangalore', 'Kolkata', '11:00', '13:45', 165, 4800, 12000, 'Airbus A321'),
            // Kolkata to Hyderabad
            flight(52, '6E-1501', 'IndiGo', 'Kolkata', 'Hyderabad', '08:00', '10:15', 135, 3800, 9500, 'Airbus A320'),
            // Hyderabad to Kolkata
            flight(53, 'AI-1001', 'Air India', 'Hyderabad', 'Kolkata', '12:00', '14:15', 135, 4000, 10000, 'Boeing 737')
        ]);
    } catch(e) { console.log('Flights insert note:', e.message); }

    try {
        await db.collection('connecting_flights').insertMany([
            { id: 1, route_name: 'Hyderabad-Delhi via Mumbai', flight1_id: 28, flight2_id: 4, layover_minutes: 90, discount_percent: 35 },
            { id: 2, route_name: 'Delhi-Chennai via Bangalore', flight1_id: 12, flight2_id: 17, layover_minutes: 75, discount_percent: 30 },
            { id: 3, route_name: 'Mumbai-Chennai via Bangalore', flight1_id: 7, flight2_id: 17, layover_minutes: 90, discount_percent: 40 },
            { id: 4, route_name: 'Chennai-Delhi via Bangalore', flight1_id: 18, flight2_id: 14, layover_minutes: 60, discount_percent: 32 },
            { id: 5, route_name: 'Kolkata-Bangalore via Delhi', flight1_id: 24, flight2_id: 12, layover_minutes: 90, discount_percent: 45 },
            { id: 6, route_name: 'Bangalore-Kolkata via Delhi', flight1_id: 14, flight2_id: 26, layover_minutes: 75, discount_percent: 38 }
        ]);
    } catch(e) { console.log('Connecting flights insert note:', e.message); }

    const count = await db.collection('flights').countDocuments();
    const cfCount = await db.collection('connecting_flights').countDocuments();
    console.log(`=== Seeded ${count} flights, 2 users, ${cfCount} connecting routes ===`);
}

// ============================================
// START SERVER
// ============================================

async function startServer() {
    try {
        const client = new MongoClient(MONGO_URI);
        await client.connect();
        db = client.db(DB_NAME);
        console.log('Connected to MongoDB Atlas!');

        await initializeData();

        app.listen(PORT, () => {
            console.log('');
            console.log('=============================================');
            console.log('  Airline Booking System is RUNNING!');
            console.log('  Open: http://localhost:' + PORT);
            console.log('=============================================');
            console.log('');
        });
    } catch(e) {
        console.error('Failed to start server:', e);
        process.exit(1);
    }
}

startServer();
