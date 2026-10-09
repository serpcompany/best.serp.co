-- serpcompany/best.serp.co#260: a published listing is never filed under a retired category
-- (`categories.is_active = 0`). The catalog maps every public listing's primary category, and a
-- listing filed under a retired one answers 404, so these refuse, whatever path the write takes:
-- publishing or republishing such a listing, filing a published listing under one, and retiring a
-- category while a published listing is still filed under it.
CREATE TRIGGER listings_refuse_retired_category_on_publication BEFORE UPDATE OF status, is_active, published_at ON listings
WHEN new.status = 'approved' AND new.is_active = 1 AND new.published_at IS NOT NULL
 AND EXISTS (SELECT 1 FROM listing_categories lc JOIN categories c ON c.id = lc.category_id
   WHERE lc.listing_id = new.id AND c.is_active = 0)
BEGIN
  SELECT RAISE(ABORT, 'published listing must not be filed under a retired category');
END;
--> statement-breakpoint
CREATE TRIGGER listing_categories_refuse_retired_category BEFORE INSERT ON listing_categories
WHEN EXISTS (SELECT 1 FROM categories WHERE id = new.category_id AND is_active = 0)
 AND EXISTS (SELECT 1 FROM listings WHERE id = new.listing_id AND status = 'approved'
   AND is_active = 1 AND published_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'published listing must not be filed under a retired category');
END;
--> statement-breakpoint
CREATE TRIGGER categories_refuse_retiring_with_published_listings BEFORE UPDATE OF is_active ON categories
WHEN new.is_active = 0
 AND EXISTS (SELECT 1 FROM listing_categories lc JOIN listings l ON l.id = lc.listing_id
   WHERE lc.category_id = new.id AND l.status = 'approved' AND l.is_active = 1
     AND l.published_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'a category with a published listing cannot retire');
END;
