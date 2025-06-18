import { 
  users, disasters, reports, resources, cache,
  type User, type InsertUser, type Disaster, type InsertDisaster, 
  type Report, type InsertReport, type Resource, type InsertResource,
  type Cache, type InsertCache
} from "@shared/schema";
import { db } from "./db";
import { eq, and, sql } from "drizzle-orm";
import { GeospatialService } from "./services/geospatial";

export interface IStorage {
  // Users
  getUser(id: number): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  // Disasters
  getDisasters(filters?: { tag?: string; ownerId?: string }): Promise<Disaster[]>;
  getDisaster(id: number): Promise<Disaster | undefined>;
  createDisaster(disaster: InsertDisaster): Promise<Disaster>;
  updateDisaster(id: number, disaster: Partial<Disaster>): Promise<Disaster | undefined>;
  deleteDisaster(id: number): Promise<boolean>;

  // Reports
  getReports(disasterId?: number): Promise<Report[]>;
  getReport(id: number): Promise<Report | undefined>;
  createReport(report: InsertReport): Promise<Report>;
  updateReport(id: number, report: Partial<Report>): Promise<Report | undefined>;

  // Resources
  getResources(disasterId?: number): Promise<Resource[]>;
  getResourcesNear(latitude: number, longitude: number, radiusKm: number): Promise<Resource[]>;
  createResource(resource: InsertResource): Promise<Resource>;

  // Cache
  getCacheValue(key: string): Promise<any | undefined>;
  setCacheValue(key: string, value: any, ttlHours: number): Promise<void>;
  clearExpiredCache(): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values(insertUser)
      .returning();
    return user;
  }

  async getDisasters(filters?: { tag?: string; ownerId?: string }): Promise<Disaster[]> {
    let query = db.select().from(disasters);
    
    if (filters?.tag) {
      query = query.where(sql`${disasters.tags} && ARRAY[${filters.tag}]`);
    }
    
    if (filters?.ownerId) {
      query = query.where(eq(disasters.ownerId, filters.ownerId));
    }
    
    return await query;
  }

  async getDisaster(id: number): Promise<Disaster | undefined> {
    const [disaster] = await db.select().from(disasters).where(eq(disasters.id, id));
    return disaster || undefined;
  }

  async createDisaster(insertDisaster: InsertDisaster): Promise<Disaster> {
    const [disaster] = await db
      .insert(disasters)
      .values(insertDisaster)
      .returning();
    return disaster;
  }

  async updateDisaster(id: number, updates: Partial<Disaster>): Promise<Disaster | undefined> {
    const [disaster] = await db
      .update(disasters)
      .set(updates)
      .where(eq(disasters.id, id))
      .returning();
    return disaster || undefined;
  }

  async deleteDisaster(id: number): Promise<boolean> {
    const result = await db.delete(disasters).where(eq(disasters.id, id));
    return result.rowCount > 0;
  }

  async getReports(disasterId?: number): Promise<Report[]> {
    if (disasterId) {
      return await db.select().from(reports).where(eq(reports.disasterId, disasterId));
    }
    return await db.select().from(reports);
  }

  async getReport(id: number): Promise<Report | undefined> {
    const [report] = await db.select().from(reports).where(eq(reports.id, id));
    return report || undefined;
  }

  async createReport(insertReport: InsertReport): Promise<Report> {
    const [report] = await db
      .insert(reports)
      .values(insertReport)
      .returning();
    return report;
  }

  async updateReport(id: number, updates: Partial<Report>): Promise<Report | undefined> {
    const [report] = await db
      .update(reports)
      .set(updates)
      .where(eq(reports.id, id))
      .returning();
    return report || undefined;
  }

  async getResources(disasterId?: number): Promise<Resource[]> {
    if (disasterId) {
      return await db.select().from(resources).where(eq(resources.disasterId, disasterId));
    }
    return await db.select().from(resources);
  }

  async getResourcesNear(latitude: number, longitude: number, radiusKm: number): Promise<Resource[]> {
    const allResources = await db.select().from(resources);
    return allResources.filter(resource => {
      if (!resource.latitude || !resource.longitude) return false;
      return GeospatialService.isWithinRadius(
        { latitude, longitude },
        { latitude: resource.latitude, longitude: resource.longitude },
        radiusKm
      );
    });
  }

  async createResource(insertResource: InsertResource): Promise<Resource> {
    const [resource] = await db
      .insert(resources)
      .values(insertResource)
      .returning();
    return resource;
  }

  async getCacheValue(key: string): Promise<any | undefined> {
    const [entry] = await db.select().from(cache).where(eq(cache.key, key));
    if (!entry) return undefined;
    
    if (new Date() > entry.expiresAt) {
      await db.delete(cache).where(eq(cache.key, key));
      return undefined;
    }
    
    return entry.value;
  }

  async setCacheValue(key: string, value: any, ttlHours: number): Promise<void> {
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    
    await db
      .insert(cache)
      .values({ key, value, expiresAt })
      .onConflictDoUpdate({
        target: cache.key,
        set: { value, expiresAt }
      });
  }

  async clearExpiredCache(): Promise<void> {
    await db.delete(cache).where(sql`${cache.expiresAt} < NOW()`);
  }
}

export class MemStorage implements IStorage {
  private users: Map<number, User>;
  private disasters: Map<number, Disaster>;
  private reports: Map<number, Report>;
  private resources: Map<number, Resource>;
  private cache: Map<string, Cache>;
  private currentUserId: number;
  private currentDisasterId: number;
  private currentReportId: number;
  private currentResourceId: number;
  private currentCacheId: number;

  constructor() {
    this.users = new Map();
    this.disasters = new Map();
    this.reports = new Map();
    this.resources = new Map();
    this.cache = new Map();
    this.currentUserId = 1;
    this.currentDisasterId = 1;
    this.currentReportId = 1;
    this.currentResourceId = 1;
    this.currentCacheId = 1;

    // Initialize hardcoded users and sample data
    this.initializeUsers();
    this.initializeSampleData();
  }

  private async initializeUsers() {
    await this.createUser({ username: "netrunnerX", password: "password123", role: "admin" });
    await this.createUser({ username: "reliefAdmin", password: "password123", role: "admin" });
    await this.createUser({ username: "citizen1", password: "password123", role: "contributor" });
  }

  private async initializeSampleData() {
    // Create sample disasters
    const disaster1 = await this.createDisaster({
      title: "NYC Flood Emergency",
      locationName: "Manhattan, NYC",
      description: "Heavy flooding in downtown Manhattan near Wall Street area",
      tags: ["flood", "urgent"],
      ownerId: "netrunnerX"
    });

    // Update with coordinates
    await this.updateDisaster(disaster1.id, {
      latitude: 40.7074,
      longitude: -73.9776
    });

    const disaster2 = await this.createDisaster({
      title: "California Wildfire Alert",
      locationName: "Los Angeles, CA",
      description: "Wildfire spreading rapidly in the hills near residential areas",
      tags: ["fire", "evacuation", "urgent"],
      ownerId: "reliefAdmin"
    });

    await this.updateDisaster(disaster2.id, {
      latitude: 34.0522,
      longitude: -118.2437
    });

    // Create sample resources
    await this.createResource({
      disasterId: disaster1.id,
      name: "Red Cross Emergency Shelter",
      locationName: "Manhattan Community Center",
      type: "shelter"
    });

    await this.createResource({
      disasterId: disaster1.id,
      name: "NYC Emergency Medical Center",
      locationName: "Lower East Side Medical",
      type: "medical"
    });

    await this.createResource({
      disasterId: disaster2.id,
      name: "Evacuation Center",
      locationName: "LA Convention Center",
      type: "shelter"
    });

    // Create sample reports
    await this.createReport({
      disasterId: disaster1.id,
      userId: "citizen1",
      content: "Water level rising rapidly on Wall Street. Need immediate evacuation assistance.",
      imageUrl: "https://example.com/flood-image.jpg"
    });

    await this.createReport({
      disasterId: disaster2.id,
      userId: "citizen1",
      content: "Smoke visible from my neighborhood. Air quality deteriorating quickly.",
      imageUrl: null
    });
  }

  // Users
  async getUser(id: number): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(user => user.username === username);
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = this.currentUserId++;
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  // Disasters
  async getDisasters(filters?: { tag?: string; ownerId?: string }): Promise<Disaster[]> {
    let disasters = Array.from(this.disasters.values());
    
    if (filters?.tag) {
      disasters = disasters.filter(d => d.tags.includes(filters.tag!));
    }
    
    if (filters?.ownerId) {
      disasters = disasters.filter(d => d.ownerId === filters.ownerId);
    }
    
    return disasters.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async getDisaster(id: number): Promise<Disaster | undefined> {
    return this.disasters.get(id);
  }

  async createDisaster(insertDisaster: InsertDisaster): Promise<Disaster> {
    const id = this.currentDisasterId++;
    const now = new Date();
    const disaster: Disaster = {
      ...insertDisaster,
      id,
      latitude: null,
      longitude: null,
      createdAt: now,
      updatedAt: now,
      auditTrail: [{
        action: "create",
        userId: insertDisaster.ownerId,
        timestamp: now.toISOString()
      }]
    };
    this.disasters.set(id, disaster);
    return disaster;
  }

  async updateDisaster(id: number, updates: Partial<Disaster>): Promise<Disaster | undefined> {
    const disaster = this.disasters.get(id);
    if (!disaster) return undefined;

    const updatedDisaster: Disaster = {
      ...disaster,
      ...updates,
      updatedAt: new Date(),
      auditTrail: [
        ...disaster.auditTrail,
        {
          action: "update",
          userId: updates.ownerId || disaster.ownerId,
          timestamp: new Date().toISOString()
        }
      ]
    };
    
    this.disasters.set(id, updatedDisaster);
    return updatedDisaster;
  }

  async deleteDisaster(id: number): Promise<boolean> {
    return this.disasters.delete(id);
  }

  // Reports
  async getReports(disasterId?: number): Promise<Report[]> {
    let reports = Array.from(this.reports.values());
    
    if (disasterId) {
      reports = reports.filter(r => r.disasterId === disasterId);
    }
    
    return reports.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async getReport(id: number): Promise<Report | undefined> {
    return this.reports.get(id);
  }

  async createReport(insertReport: InsertReport): Promise<Report> {
    const id = this.currentReportId++;
    const report: Report = {
      ...insertReport,
      id,
      verificationStatus: "pending",
      createdAt: new Date()
    };
    this.reports.set(id, report);
    return report;
  }

  async updateReport(id: number, updates: Partial<Report>): Promise<Report | undefined> {
    const report = this.reports.get(id);
    if (!report) return undefined;

    const updatedReport: Report = { ...report, ...updates };
    this.reports.set(id, updatedReport);
    return updatedReport;
  }

  // Resources
  async getResources(disasterId?: number): Promise<Resource[]> {
    let resources = Array.from(this.resources.values());
    
    if (disasterId) {
      resources = resources.filter(r => r.disasterId === disasterId);
    }
    
    return resources.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async getResourcesNear(latitude: number, longitude: number, radiusKm: number): Promise<Resource[]> {
    const resources = Array.from(this.resources.values());
    
    return resources.filter(resource => {
      if (!resource.latitude || !resource.longitude) return false;
      
      const distance = this.calculateDistance(
        latitude, longitude,
        resource.latitude, resource.longitude
      );
      
      return distance <= radiusKm;
    });
  }

  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  async createResource(insertResource: InsertResource): Promise<Resource> {
    const id = this.currentResourceId++;
    const resource: Resource = {
      ...insertResource,
      id,
      latitude: null,
      longitude: null,
      createdAt: new Date()
    };
    this.resources.set(id, resource);
    return resource;
  }

  async updateResource(id: number, updates: Partial<Resource>): Promise<Resource | undefined> {
    const resource = this.resources.get(id);
    if (!resource) return undefined;

    const updatedResource: Resource = { ...resource, ...updates };
    this.resources.set(id, updatedResource);
    return updatedResource;
  }

  // Cache
  async getCacheValue(key: string): Promise<any | undefined> {
    const cached = Array.from(this.cache.values()).find(c => c.key === key);
    
    if (!cached) return undefined;
    
    if (new Date() > cached.expiresAt) {
      this.cache.delete(cached.id);
      return undefined;
    }
    
    return cached.value;
  }

  async setCacheValue(key: string, value: any, ttlHours: number): Promise<void> {
    // Remove existing cache entry with same key
    const existing = Array.from(this.cache.values()).find(c => c.key === key);
    if (existing) {
      this.cache.delete(existing.id);
    }

    const id = this.currentCacheId++;
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + ttlHours);
    
    const cacheEntry: Cache = {
      id,
      key,
      value,
      expiresAt
    };
    
    this.cache.set(id, cacheEntry);
  }

  async clearExpiredCache(): Promise<void> {
    const now = new Date();
    const expired = Array.from(this.cache.values()).filter(c => c.expiresAt < now);
    expired.forEach(c => this.cache.delete(c.id));
  }
}

export const storage = new MemStorage();
