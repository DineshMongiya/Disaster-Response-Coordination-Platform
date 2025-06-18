import type { Express } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import { mockApiService } from "./services/mockApis";
import { GeospatialService } from "./services/geospatial";
import { insertDisasterSchema, insertReportSchema, insertResourceSchema } from "@shared/schema";

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // WebSocket server for real-time updates
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('WebSocket client connected');

    ws.on('close', () => {
      clients.delete(ws);
      console.log('WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      clients.delete(ws);
    });
  });

  // Broadcast function for real-time updates
  function broadcast(event: string, data: any) {
    const message = JSON.stringify({ event, data });
    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  // Mock authentication middleware
  function authenticateUser(req: any, res: any, next: any) {
    const username = req.headers['x-user'] || 'netrunnerX';
    req.user = { username, role: username === 'netrunnerX' || username === 'reliefAdmin' ? 'admin' : 'contributor' };
    next();
  }

  app.use('/api', authenticateUser);

  // Cache middleware
  async function checkCache(key: string) {
    return await storage.getCacheValue(key);
  }

  async function setCache(key: string, value: any, ttlHours: number = 1) {
    await storage.setCacheValue(key, value, ttlHours);
  }

  // Disasters endpoints
  app.get('/api/disasters', async (req, res) => {
    try {
      const { tag, owner } = req.query;
      const filters: any = {};
      
      if (tag) filters.tag = tag as string;
      if (owner) filters.ownerId = owner as string;

      const disasters = await storage.getDisasters(filters);
      console.log(`Fetched ${disasters.length} disasters with filters:`, filters);
      res.json(disasters);
    } catch (error) {
      console.error('Error fetching disasters:', error);
      res.status(500).json({ message: 'Failed to fetch disasters' });
    }
  });

  app.get('/api/disasters/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const disaster = await storage.getDisaster(id);
      
      if (!disaster) {
        return res.status(404).json({ message: 'Disaster not found' });
      }

      console.log(`Fetched disaster: ${disaster.title}`);
      res.json(disaster);
    } catch (error) {
      console.error('Error fetching disaster:', error);
      res.status(500).json({ message: 'Failed to fetch disaster' });
    }
  });

  app.post('/api/disasters', async (req, res) => {
    try {
      const validatedData = insertDisasterSchema.parse({
        ...req.body,
        ownerId: req.user.username
      });

      const disaster = await storage.createDisaster(validatedData);
      
      // Try to extract location and geocode
      try {
        const locationResult = await mockApiService.extractLocationFromText(
          disaster.description + ' ' + disaster.locationName
        );
        
        if (locationResult.location) {
          const geocodeResult = await mockApiService.geocodeLocation(locationResult.location);
          if (geocodeResult) {
            const updatedDisaster = await storage.updateDisaster(disaster.id, {
              latitude: geocodeResult.latitude,
              longitude: geocodeResult.longitude
            });
            
            if (updatedDisaster) {
              broadcast('disaster_created', updatedDisaster);
              console.log(`Created disaster: ${updatedDisaster.title} at ${locationResult.location}`);
              return res.status(201).json(updatedDisaster);
            }
          }
        }
      } catch (locationError) {
        console.error('Location processing error:', locationError);
      }

      broadcast('disaster_created', disaster);
      console.log(`Created disaster: ${disaster.title}`);
      res.status(201).json(disaster);
    } catch (error) {
      console.error('Error creating disaster:', error);
      res.status(400).json({ message: 'Invalid disaster data' });
    }
  });

  app.put('/api/disasters/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;
      
      const disaster = await storage.updateDisaster(id, updates);
      
      if (!disaster) {
        return res.status(404).json({ message: 'Disaster not found' });
      }

      broadcast('disaster_updated', disaster);
      console.log(`Updated disaster: ${disaster.title}`);
      res.json(disaster);
    } catch (error) {
      console.error('Error updating disaster:', error);
      res.status(500).json({ message: 'Failed to update disaster' });
    }
  });

  app.delete('/api/disasters/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const success = await storage.deleteDisaster(id);
      
      if (!success) {
        return res.status(404).json({ message: 'Disaster not found' });
      }

      broadcast('disaster_deleted', { id });
      console.log(`Deleted disaster with ID: ${id}`);
      res.status(204).send();
    } catch (error) {
      console.error('Error deleting disaster:', error);
      res.status(500).json({ message: 'Failed to delete disaster' });
    }
  });

  // Social media endpoints
  app.get('/api/disasters/:id/social-media', async (req, res) => {
    try {
      const disasterId = parseInt(req.params.id);
      const cacheKey = `social-media-${disasterId}`;
      
      // Check cache first
      let cachedData = await checkCache(cacheKey);
      if (cachedData) {
        console.log(`Returning cached social media data for disaster ${disasterId}`);
        return res.json(cachedData);
      }

      const socialData = await mockApiService.fetchSocialMediaReports();
      
      // Cache the results
      await setCache(cacheKey, socialData, 0.25); // 15 minutes cache
      
      broadcast('social_media_updated', { disasterId, data: socialData });
      console.log(`Fetched ${socialData.length} social media reports for disaster ${disasterId}`);
      res.json(socialData);
    } catch (error) {
      console.error('Error fetching social media data:', error);
      res.status(500).json({ message: 'Failed to fetch social media data' });
    }
  });

  // Resources endpoints
  app.get('/api/disasters/:id/resources', async (req, res) => {
    try {
      const disasterId = parseInt(req.params.id);
      const { lat, lon, radius = 10 } = req.query;

      let resources;
      
      if (lat && lon) {
        const latitude = parseFloat(lat as string);
        const longitude = parseFloat(lon as string);
        const radiusKm = parseFloat(radius as string);
        
        resources = await storage.getResourcesNear(latitude, longitude, radiusKm);
        console.log(`Found ${resources.length} resources within ${radiusKm}km of (${latitude}, ${longitude})`);
      } else {
        resources = await storage.getResources(disasterId);
        console.log(`Found ${resources.length} resources for disaster ${disasterId}`);
      }

      res.json(resources);
    } catch (error) {
      console.error('Error fetching resources:', error);
      res.status(500).json({ message: 'Failed to fetch resources' });
    }
  });

  app.post('/api/resources', async (req, res) => {
    try {
      const validatedData = insertResourceSchema.parse(req.body);
      const resource = await storage.createResource(validatedData);

      // Try to geocode the location
      try {
        const geocodeResult = await mockApiService.geocodeLocation(resource.locationName);
        if (geocodeResult) {
          const updatedResource = await storage.updateResource(resource.id, {
            latitude: geocodeResult.latitude,
            longitude: geocodeResult.longitude
          });
          
          if (updatedResource) {
            broadcast('resources_updated', updatedResource);
            console.log(`Created resource: ${updatedResource.name} at ${resource.locationName}`);
            return res.status(201).json(updatedResource);
          }
        }
      } catch (geocodeError) {
        console.error('Geocoding error for resource:', geocodeError);
      }

      broadcast('resources_updated', resource);
      console.log(`Created resource: ${resource.name}`);
      res.status(201).json(resource);
    } catch (error) {
      console.error('Error creating resource:', error);
      res.status(400).json({ message: 'Invalid resource data' });
    }
  });

  // Reports endpoints
  app.get('/api/reports', async (req, res) => {
    try {
      const { disasterId } = req.query;
      const reports = await storage.getReports(disasterId ? parseInt(disasterId as string) : undefined);
      console.log(`Fetched ${reports.length} reports`);
      res.json(reports);
    } catch (error) {
      console.error('Error fetching reports:', error);
      res.status(500).json({ message: 'Failed to fetch reports' });
    }
  });

  app.post('/api/reports', async (req, res) => {
    try {
      const validatedData = insertReportSchema.parse({
        ...req.body,
        userId: req.user.username
      });

      const report = await storage.createReport(validatedData);
      console.log(`Created report for disaster ${report.disasterId}`);
      res.status(201).json(report);
    } catch (error) {
      console.error('Error creating report:', error);
      res.status(400).json({ message: 'Invalid report data' });
    }
  });

  // Official updates endpoint
  app.get('/api/disasters/:id/official-updates', async (req, res) => {
    try {
      const disasterId = parseInt(req.params.id);
      const cacheKey = `official-updates-${disasterId}`;
      
      // Check cache first
      let cachedData = await checkCache(cacheKey);
      if (cachedData) {
        console.log(`Returning cached official updates for disaster ${disasterId}`);
        return res.json(cachedData);
      }

      const updates = await mockApiService.fetchOfficialUpdates();
      
      // Cache the results
      await setCache(cacheKey, updates, 1); // 1 hour cache
      
      console.log(`Fetched ${updates.length} official updates for disaster ${disasterId}`);
      res.json(updates);
    } catch (error) {
      console.error('Error fetching official updates:', error);
      res.status(500).json({ message: 'Failed to fetch official updates' });
    }
  });

  // Image verification endpoint
  app.post('/api/disasters/:id/verify-image', async (req, res) => {
    try {
      const disasterId = parseInt(req.params.id);
      const { imageUrl, reportId } = req.body;

      if (!imageUrl) {
        return res.status(400).json({ message: 'Image URL is required' });
      }

      const cacheKey = `image-verification-${Buffer.from(imageUrl).toString('base64')}`;
      
      // Check cache first
      let cachedResult = await checkCache(cacheKey);
      if (cachedResult) {
        console.log(`Returning cached image verification for ${imageUrl}`);
        return res.json(cachedResult);
      }

      const verificationResult = await mockApiService.verifyImage(imageUrl);
      
      // Cache the results
      await setCache(cacheKey, verificationResult, 24); // 24 hour cache
      
      // Update report if reportId provided
      if (reportId) {
        const status = verificationResult.isAuthentic ? 'verified' : 'disputed';
        await storage.updateReport(parseInt(reportId), { verificationStatus: status });
      }

      console.log(`Image verification completed for disaster ${disasterId}: ${verificationResult.isAuthentic ? 'authentic' : 'disputed'}`);
      res.json(verificationResult);
    } catch (error) {
      console.error('Error verifying image:', error);
      res.status(500).json({ message: 'Failed to verify image' });
    }
  });

  // Geocoding endpoint
  app.post('/api/geocode', async (req, res) => {
    try {
      const { text, locationName } = req.body;

      if (!text && !locationName) {
        return res.status(400).json({ message: 'Text or location name is required' });
      }

      let location = locationName;
      
      // Extract location from text if needed
      if (text && !locationName) {
        const extractionResult = await mockApiService.extractLocationFromText(text);
        if (!extractionResult.location) {
          return res.status(404).json({ message: 'No location found in text' });
        }
        location = extractionResult.location;
      }

      const cacheKey = `geocode-${location.toLowerCase()}`;
      
      // Check cache first
      let cachedResult = await checkCache(cacheKey);
      if (cachedResult) {
        console.log(`Returning cached geocoding for ${location}`);
        return res.json(cachedResult);
      }

      const geocodeResult = await mockApiService.geocodeLocation(location);
      
      if (!geocodeResult) {
        return res.status(404).json({ message: 'Location not found' });
      }

      // Cache the results
      await setCache(cacheKey, geocodeResult, 72); // 72 hour cache
      
      console.log(`Geocoded ${location} to (${geocodeResult.latitude}, ${geocodeResult.longitude})`);
      res.json(geocodeResult);
    } catch (error) {
      console.error('Error geocoding:', error);
      res.status(500).json({ message: 'Failed to geocode location' });
    }
  });

  // Stats endpoint for dashboard
  app.get('/api/stats', async (req, res) => {
    try {
      const disasters = await storage.getDisasters();
      const reports = await storage.getReports();
      const resources = await storage.getResources();
      
      const stats = {
        activeDisasters: disasters.length,
        totalReports: reports.length,
        verifiedReports: reports.filter(r => r.verificationStatus === 'verified').length,
        totalResources: resources.length,
        lastUpdated: new Date().toISOString()
      };

      res.json(stats);
    } catch (error) {
      console.error('Error fetching stats:', error);
      res.status(500).json({ message: 'Failed to fetch stats' });
    }
  });

  // Clean up expired cache periodically
  setInterval(async () => {
    try {
      await storage.clearExpiredCache();
    } catch (error) {
      console.error('Error clearing expired cache:', error);
    }
  }, 5 * 60 * 1000); // Every 5 minutes

  return httpServer;
}
