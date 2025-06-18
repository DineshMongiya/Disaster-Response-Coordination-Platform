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
