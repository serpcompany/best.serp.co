-- serpcompany/best.serp.co#341 (#343, design 1.4): an active tag always sits under an active
-- category (its hub), and a listing is never newly tagged with a retired tag. Retiring a tag
-- leaves its listings as they are: public reads filter on the tag's `is_active`. The insert and
-- the update of a tag refuse a retired hub separately, because a trigger has one event.
CREATE TRIGGER listing_tags_refuse_retired_tag BEFORE INSERT ON listing_tags
WHEN EXISTS (SELECT 1 FROM tags WHERE id = new.tag_id AND is_active = 0)
BEGIN
  SELECT RAISE(ABORT, 'a listing must not be tagged with a retired tag');
END;
--> statement-breakpoint
CREATE TRIGGER tags_refuse_retired_category BEFORE INSERT ON tags
WHEN EXISTS (SELECT 1 FROM categories WHERE id = new.category_id AND is_active = 0)
BEGIN
  SELECT RAISE(ABORT, 'a tag must not be filed under a retired category');
END;
--> statement-breakpoint
CREATE TRIGGER tags_refuse_retired_category_on_update BEFORE UPDATE OF category_id, is_active ON tags
WHEN (new.category_id IS NOT old.category_id OR new.is_active = 1)
 AND EXISTS (SELECT 1 FROM categories WHERE id = new.category_id AND is_active = 0)
BEGIN
  SELECT RAISE(ABORT, 'a tag must not be filed under a retired category');
END;
--> statement-breakpoint
CREATE TRIGGER categories_refuse_retiring_with_active_tags BEFORE UPDATE OF is_active ON categories
WHEN new.is_active = 0
 AND EXISTS (SELECT 1 FROM tags WHERE category_id = new.id AND is_active = 1)
BEGIN
  SELECT RAISE(ABORT, 'a category with an active tag cannot retire');
END;
